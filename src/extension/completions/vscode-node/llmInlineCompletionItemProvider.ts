/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { CancellationToken, InlineCompletionContext, InlineCompletionItem, InlineCompletionItemProvider, InlineCompletionList, Position, Range, TextDocument } from 'vscode';
import { ChatLocation, ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { toTextParts } from '../../../platform/chat/common/globalStringUtils';
import { IConversationOptions } from '../../../platform/chat/common/conversationOptions';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEndpointProvider, ChatEndpointFamily } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { EXTENSION_ID } from '../../common/constants';
import { ThrottledDelayer, raceCancellation, timeout } from '../../../util/vs/base/common/async';
import { CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

interface CompletionSession {
        readonly requestUuid: string;
        readonly documentUri: string;
        readonly documentVersion: number;
        readonly position: Position;
        readonly range: Range;
        readonly cancellation: CancellationTokenSource;
        text: string;
        done: boolean;
        error?: string;
}

export class LlmInlineCompletionItemProvider extends Disposable implements InlineCompletionItemProvider {
        private static readonly MAX_PREFIX_CHARS = 4000;
        private static readonly MAX_SUFFIX_CHARS = 2000;
        private static readonly STREAM_UPDATE_DELAY = 50;
        private static readonly MIN_REQUEST_INTERVAL = 75;

        private readonly _sessions = new Map<string, CompletionSession>();
        private readonly _onDidChangeEmitter = this._register(new Emitter<void>());
        public readonly onDidChange = this._onDidChangeEmitter.event;
        private readonly _updateDelayer = new ThrottledDelayer<void>(LlmInlineCompletionItemProvider.STREAM_UPDATE_DELAY);
        private _lastRequestTimestamp = 0;

        constructor(
                @IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
                @IChatMLFetcher private readonly _chatFetcher: IChatMLFetcher,
                @IConversationOptions private readonly _conversationOptions: IConversationOptions,
                @IConfigurationService private readonly _configurationService: IConfigurationService,
                @ILogService private readonly _logService: ILogService,
        ) {
                super();
                this._register({ dispose: () => this._updateDelayer.dispose() });
        }

        public async provideInlineCompletionItems(document: TextDocument, position: Position, context: InlineCompletionContext, token: CancellationToken): Promise<InlineCompletionList | undefined> {
                if (!this._isLanguageEnabled(document)) {
                        return undefined;
                }

                if (this._isAtMidWord(document, position)) {
                        return undefined;
                }

                const requestKey = context.requestUuid ?? `${document.uri.toString()}#${document.version}#${position.line}:${position.character}`;
                let session = this._sessions.get(requestKey);

                if (session && session.documentVersion !== document.version) {
                        this._clearSession(session.requestUuid, true);
                        session = undefined;
                }

                if (!session) {
                        const range = new Range(position, position);
                        const cancellation = new CancellationTokenSource(token);
                        session = {
                                requestUuid: requestKey,
                                documentUri: document.uri.toString(),
                                documentVersion: document.version,
                                position,
                                range,
                                cancellation,
                                text: '',
                                done: false,
                        };
                        this._sessions.set(requestKey, session);
                        token.onCancellationRequested(() => this._clearSession(requestKey, true));
                        void this._requestCompletion(session, document, position, context.userPrompt ?? '', cancellation.token);
                        return undefined;
                }

                if (session.error) {
                        this._clearSession(session.requestUuid, true);
                        return undefined;
                }

                if (!session.text) {
                        return undefined;
                }

                const item = new InlineCompletionItem(session.text, session.range);
                item.correlationId = session.requestUuid;
                const list = new InlineCompletionList([item]);
                list.enableForwardStability = true;
                return list;
        }

        // eslint-disable-next-line local/vscode-dts-provider-naming
        public handleEndOfLifetime(completionItem: InlineCompletionItem): void {
                if (completionItem.correlationId) {
                        this._clearSession(completionItem.correlationId, false);
                }
        }

        // eslint-disable-next-line local/vscode-dts-provider-naming
        public handleListEndOfLifetime(list: InlineCompletionList): void {
                const correlationId = list.items[0]?.correlationId;
                if (correlationId) {
                        this._clearSession(correlationId, false);
                }
        }

        private async _requestCompletion(session: CompletionSession, document: TextDocument, position: Position, userPrompt: string, cancellationToken: CancellationToken): Promise<void> {
                try {
                        await this._throttle(cancellationToken);
                        if (cancellationToken.isCancellationRequested) {
                                return;
                        }

                        const { prefix, suffix } = this._extractContext(document, position);
                        const endpoint = await this._endpointProvider.getChatEndpoint(ChatEndpointFamily.CopilotBase);

                        const messages: Raw.ChatMessage[] = [
                                {
                                        role: Raw.ChatRole.System,
                                        content: toTextParts('You are an AI code assistant that provides helpful inline completions. Return only the continuation of the code without additional commentary.')
                                },
                                {
                                        role: Raw.ChatRole.User,
                                        content: toTextParts(this._buildUserPrompt(document, prefix, suffix, userPrompt))
                                }
                        ];

                        const requestOptions = {
                                max_tokens: Math.min(this._conversationOptions.maxResponseTokens ?? endpoint.maxOutputTokens, endpoint.maxOutputTokens),
                                temperature: this._conversationOptions.temperature,
                                top_p: this._conversationOptions.topP,
                        };

                        const response = await this._chatFetcher.fetchOne({
                                debugName: 'inlineCompletion.singleTurn',
                                endpoint,
                                messages,
                                finishedCb: async (text, _index, delta) => {
                                        if (cancellationToken.isCancellationRequested) {
                                                return 0;
                                        }

                                        if (delta.text) {
                                                session.text = text;
                                                this._scheduleDidChange();
                                        }

                                        return undefined;
                                },
                                location: ChatLocation.Other,
                                requestOptions,
                                source: { extensionId: EXTENSION_ID },
                                userInitiatedRequest: false,
                        }, cancellationToken);

                        if (response.type === ChatFetchResponseType.Success) {
                                if (!session.text) {
                                        session.text = response.value;
                                        this._scheduleDidChange();
                                }
                                session.done = true;
                        } else if (response.type === ChatFetchResponseType.Canceled) {
                                session.error = 'cancelled';
                        } else {
                                session.error = response.reason;
                                this._logService.debug(`[InlineCompletion] LLM request failed: ${response.type} - ${response.reason}`);
                        }
                } catch (err) {
                        if (!cancellationToken.isCancellationRequested) {
                                const message = err instanceof Error ? err.message : String(err);
                                session.error = message;
                                this._logService.error('[InlineCompletion] Failed to fetch completion', err);
                        }
                } finally {
                        session.cancellation.dispose();
                        if (session.error) {
                                this._scheduleDidChange();
                        }
                }
        }

        private _isLanguageEnabled(document: TextDocument): boolean {
                const enabledLanguages = this._configurationService.getConfig(ConfigKey.Shared.Enable) as Record<string, boolean | undefined> | undefined;
                if (!enabledLanguages) {
                        return true;
                }

                const map = new Map(Object.entries(enabledLanguages));
                if (!map.has('*')) {
                        map.set('*', true);
                }
                const value = map.get(document.languageId);
                return value ?? map.get('*') ?? true;
        }

        private _isAtMidWord(document: TextDocument, position: Position): boolean {
                const line = document.lineAt(position.line);
                if (position.character >= line.range.end.character) {
                        return false;
                }
                const nextRange = new Range(position, position.translate(0, 1));
                const nextChar = document.getText(nextRange);
                return /\w/.test(nextChar);
        }

        private _extractContext(document: TextDocument, position: Position): { prefix: string; suffix: string } {
                const start = new Position(0, 0);
                const end = document.lineCount === 0 ? start : document.lineAt(document.lineCount - 1).range.end;
                const prefixFull = document.getText(new Range(start, position));
                const suffixFull = document.getText(new Range(position, end));
                const prefix = prefixFull.slice(-LlmInlineCompletionItemProvider.MAX_PREFIX_CHARS);
                const suffix = suffixFull.slice(0, LlmInlineCompletionItemProvider.MAX_SUFFIX_CHARS);
                return { prefix, suffix };
        }

        private _buildUserPrompt(document: TextDocument, prefix: string, suffix: string, userPrompt: string): string {
                const parts = [
                        `Language: ${document.languageId}`,
                        'Continue the code at the cursor. Provide only valid code with no explanation or surrounding quotes.',
                ];

                if (userPrompt) {
                        parts.push('', 'User instruction:', userPrompt.trim());
                }

                parts.push('', 'Prefix:', prefix || '<empty>');
                parts.push('', 'Suffix:', suffix || '<empty>');
                return parts.join('\n');
        }

        private async _throttle(token: CancellationToken): Promise<void> {
                        const now = Date.now();
                        const diff = LlmInlineCompletionItemProvider.MIN_REQUEST_INTERVAL - (now - this._lastRequestTimestamp);
                        if (diff > 0) {
                                await raceCancellation(timeout(diff), token);
                        }
                        this._lastRequestTimestamp = Date.now();
        }

        private _scheduleDidChange(): void {
                void this._updateDelayer.trigger(async () => {
                        this._onDidChangeEmitter.fire();
                });
        }

        private _clearSession(requestUuid: string, cancel: boolean): void {
                const session = this._sessions.get(requestUuid);
                if (!session) {
                        return;
                }
                if (cancel && !session.cancellation.token.isCancellationRequested) {
                        session.cancellation.cancel();
                }
                session.cancellation.dispose();
                this._sessions.delete(requestUuid);
                this._scheduleDidChange();
        }
}
