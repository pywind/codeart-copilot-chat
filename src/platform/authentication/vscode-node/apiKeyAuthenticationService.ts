/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AuthenticationGetSessionOptions, AuthenticationSession } from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { ILogService } from '../../log/common/logService';
import { IAuthenticationService } from '../common/authentication';
import { CopilotToken } from '../common/copilotToken';
import { ICopilotTokenManager } from '../common/copilotTokenManager';
import { ICopilotTokenStore } from '../common/copilotTokenStore';
import { onDidChangeApiKey } from '../common/apiKeyStorage';

export class ApiKeyAuthenticationService extends Disposable implements IAuthenticationService {
        declare readonly _serviceBrand: undefined;

        private readonly _onDidAuthenticationChange = this._register(new Emitter<void>());
        readonly onDidAuthenticationChange: Event<void> = this._onDidAuthenticationChange.event;

        private readonly _onDidAccessTokenChange = this._register(new Emitter<void>());
        readonly onDidAccessTokenChange: Event<void> = this._onDidAccessTokenChange.event;

        private readonly _onDidAdoAuthenticationChange = this._register(new Emitter<void>());
        readonly onDidAdoAuthenticationChange: Event<void> = this._onDidAdoAuthenticationChange.event;

        speculativeDecodingEndpointToken: string | undefined;

        constructor(
                @ILogService private readonly logService: ILogService,
                @ICopilotTokenStore private readonly tokenStore: ICopilotTokenStore,
                @ICopilotTokenManager private readonly tokenManager: ICopilotTokenManager,
        ) {
                super();

                this._register(this.tokenManager.onDidCopilotTokenRefresh(() => {
                        this.logService.debug('Copilot token refreshed from MyAI API key.');
                        void this.getCopilotToken().catch(() => undefined);
                        this._onDidAuthenticationChange.fire();
                }));

                this._register(onDidChangeApiKey(() => {
                        this.logService.debug('Detected MyAI API key change.');
                        this.tokenStore.copilotToken = undefined;
                        this.tokenManager.resetCopilotToken();
                        this._onDidAccessTokenChange.fire();
                        this._onDidAuthenticationChange.fire();
                }));
        }

        get isMinimalMode(): boolean {
                return false;
        }

        get anyGitHubSession(): AuthenticationSession | undefined {
                return undefined;
        }

        async getAnyGitHubSession(_options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
                return undefined;
        }

        get permissiveGitHubSession(): AuthenticationSession | undefined {
                return undefined;
        }

        async getPermissiveGitHubSession(_options: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
                return undefined;
        }

        get copilotToken() {
                return this.tokenStore.copilotToken;
        }

        async getCopilotToken(force?: boolean) {
                const token = await this.tokenManager.getCopilotToken(force);
                this.tokenStore.copilotToken = token;
                return token;
        }

        resetCopilotToken(httpError?: number): void {
                this.tokenStore.copilotToken = undefined;
                this.tokenManager.resetCopilotToken(httpError);
        }

        setCopilotTokenForTesting(token: CopilotToken): void {
                this.tokenStore.copilotToken = token;
        }

        async getAdoAccessTokenBase64(_options?: AuthenticationGetSessionOptions): Promise<string | undefined> {
                return undefined;
        }
}

