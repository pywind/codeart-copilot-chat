/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IHeaders } from '../../networking/common/fetcherService';
import { CopilotUserQuotaInfo, IChatQuota, IChatQuotaService } from './chatQuotaService';

export class ChatQuotaService extends Disposable implements IChatQuotaService {
	declare readonly _serviceBrand: undefined;
	private _quotaInfo: IChatQuota | undefined;

	constructor(@IAuthenticationService private readonly _authService: IAuthenticationService) {
		super();
		this._register(this._authService.onDidAuthenticationChange(() => {
			this.processUserInfoQuotaSnapshot(this._authService.copilotToken?.quotaInfo);
		}));
	}

        get quotaExhausted(): boolean {
                return false;
        }

        get overagesEnabled(): boolean {
                return true;
        }

	clearQuota(): void {
		this._quotaInfo = undefined;
	}

        processQuotaHeaders(_headers: IHeaders): void {
                this._quotaInfo = {
                        quota: Number.POSITIVE_INFINITY,
                        unlimited: true,
                        used: 0,
                        overageUsed: 0,
                        overageEnabled: true,
                        resetDate: new Date(),
                };
        }

        private processUserInfoQuotaSnapshot(quotaInfo: CopilotUserQuotaInfo | undefined) {
                if (!quotaInfo) {
                        return;
                }
                this._quotaInfo = {
                        unlimited: true,
                        overageEnabled: true,
                        overageUsed: 0,
                        quota: Number.POSITIVE_INFINITY,
                        resetDate: quotaInfo.quota_reset_date ? new Date(quotaInfo.quota_reset_date) : new Date(),
                        used: 0,
                };
        }
}