/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Uri } from 'vscode';
import type { IMultiFileEdit, IMultiFileEditInternalTelemetryService, IMultiFileEditRequestInfo, IMultiFileEditTelemetry } from './multiFileEditQualityTelemetry';

export class NullMultiFileEditInternalTelemetryService implements IMultiFileEditInternalTelemetryService {

        declare _serviceBrand: undefined;

        storeEditPrompt(_edit: IMultiFileEdit, _telemetryOptions: IMultiFileEditTelemetry): void {
                return;
        }

        async sendEditPromptAndResult(_telemetry: IMultiFileEditRequestInfo, _uri: Uri, _outcome: 'accept' | 'reject'): Promise<void> {
                return;
        }
}
