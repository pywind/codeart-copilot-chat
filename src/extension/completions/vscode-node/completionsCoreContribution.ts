/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { languages } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { autorun, observableFromEvent } from '../../../util/vs/base/common/observableInternal';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LlmInlineCompletionItemProvider } from './llmInlineCompletionItemProvider';
import { unificationStateObservable } from './completionsUnificationContribution';

export class CompletionsCoreContribution extends Disposable {

        private provider: LlmInlineCompletionItemProvider | undefined;
        private readonly copilotToken = observableFromEvent(this, this.authenticationService.onDidAuthenticationChange, () => this.authenticationService.copilotToken);

        constructor(
                @IInstantiationService private readonly instantiationService: IInstantiationService,
                @IConfigurationService configurationService: IConfigurationService,
                @IExperimentationService experimentationService: IExperimentationService,
                @IAuthenticationService private readonly authenticationService: IAuthenticationService,
        ) {
                super();

                const unificationState = unificationStateObservable(this);
                const configEnabled = configurationService.getExperimentBasedConfigObservable<boolean>(ConfigKey.Internal.InlineEditsEnableGhCompletionsProvider, experimentationService);

                this._register(autorun(reader => {
                        const shouldRegister = Boolean(unificationState.read(reader)?.codeUnification || configEnabled.read(reader) || this.copilotToken.read(reader)?.isNoAuthUser);
                        if (shouldRegister) {
                                const provider = this.getOrCreateProvider();
                                reader.store.add(languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider, { debounceDelayMs: 0, excludes: ['github.copilot'], groupId: 'completions' }));
                        }
                }));
        }

        private getOrCreateProvider(): LlmInlineCompletionItemProvider {
                if (!this.provider) {
                        this.provider = this._register(this.instantiationService.createInstance(LlmInlineCompletionItemProvider));
                }
                return this.provider;
        }
}
