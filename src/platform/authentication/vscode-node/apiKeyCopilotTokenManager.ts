/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { ILogService } from '../../log/common/logService';
import { CopilotToken, ExtendedTokenInfo } from '../common/copilotToken';
import { ICopilotTokenManager, nowSeconds } from '../common/copilotTokenManager';
import { getApiKey, onDidChangeApiKey } from '../common/apiKeyStorage';

const REFRESH_SECONDS = 24 * 60 * 60;

export class ApiKeyCopilotTokenManager extends Disposable implements ICopilotTokenManager {
        declare readonly _serviceBrand: undefined;

        private readonly _onDidCopilotTokenRefresh = this._register(new Emitter<void>());
        readonly onDidCopilotTokenRefresh: Event<void> = this._onDidCopilotTokenRefresh.event;

        private cachedToken: CopilotToken | undefined;

        constructor(@ILogService private readonly logService: ILogService) {
                super();

                this._register(onDidChangeApiKey(() => {
                        this.logService.debug('MyAI API key changed; clearing cached Copilot token.');
                        this.cachedToken = undefined;
                        this._onDidCopilotTokenRefresh.fire();
                }));
        }

        async getCopilotToken(force?: boolean): Promise<CopilotToken> {
                const apiKey = getApiKey();
                if (!apiKey) {
                        this.logService.warn('Attempted to retrieve Copilot token before API key was configured.');
                        throw new Error('MyAI API key is not configured.');
                }

                if (!this.cachedToken || force) {
                        this.cachedToken = this.createToken(apiKey);
                }

                return this.cachedToken;
        }

        resetCopilotToken(): void {
                this.cachedToken = undefined;
                this._onDidCopilotTokenRefresh.fire();
        }

        private createToken(apiKey: string): CopilotToken {
                const now = nowSeconds();
                const tokenInfo: ExtendedTokenInfo = {
                        token: `key=${apiKey}`,
                        expires_at: now + REFRESH_SECONDS,
                        refresh_in: REFRESH_SECONDS,
                        organization_list: [],
                        code_quote_enabled: true,
                        public_suggestions: 'enabled',
                        telemetry: 'enabled',
                        copilotignore_enabled: true,
                        endpoints: undefined,
                        chat_enabled: true,
                        limited_user_quotas: undefined,
                        enterprise_list: [],
                        individual: true,
                        sku: 'myai_api_key',
                        message: undefined,
                        username: 'myai',
                        isVscodeTeamMember: false,
                        copilot_plan: 'business',
                        quota_snapshots: undefined,
                        quota_reset_date: undefined,
                };

                this.logService.debug('Created new Copilot token from MyAI API key.');
                return new CopilotToken(tokenInfo);
        }
}

