/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigurationTarget, ExtensionContext, window, workspace } from 'vscode';
import { setApiKey } from '../../../platform/authentication/common/apiKeyStorage';

export const API_KEY_SECRET_KEY = 'myai.apiKey';

export async function ensureMyAIConfigured(context: ExtensionContext): Promise<boolean> {
        const configuration = workspace.getConfiguration('myai');

        const existingApiKey = await context.secrets.get(API_KEY_SECRET_KEY);
        if (existingApiKey) {
                setApiKey(existingApiKey);
        }

        const apiBaseUrl = configuration.get<string>('apiBaseUrl');
        const defaultModel = configuration.get<string>('defaultModel');

        const needsSetup = !existingApiKey || !apiBaseUrl || !defaultModel;
        if (!needsSetup) {
                return true;
        }

        const configure = await window.showInformationMessage(
                'MyAI needs to be configured before the extension can be used.',
                'Configure Now',
                'Cancel'
        );

        if (configure !== 'Configure Now') {
                return false;
        }

        const apiKey = await window.showInputBox({
                prompt: 'Enter your MyAI API key',
                ignoreFocusOut: true,
                password: true,
                placeHolder: 'sk-...',
        });

        if (!apiKey) {
                return false;
        }

        const baseUrl = await window.showInputBox({
                prompt: 'Enter the MyAI API base URL',
                ignoreFocusOut: true,
                value: apiBaseUrl ?? 'https://api.myai.local',
        });

        if (!baseUrl) {
                return false;
        }

        const model = await window.showInputBox({
                prompt: 'Enter the default model to use',
                ignoreFocusOut: true,
                value: defaultModel ?? 'myai-latest',
        });

        if (!model) {
                return false;
        }

        await context.secrets.store(API_KEY_SECRET_KEY, apiKey);
        setApiKey(apiKey);

        await configuration.update('apiBaseUrl', baseUrl, ConfigurationTarget.Global);
        await configuration.update('defaultModel', model, ConfigurationTarget.Global);

        return true;
}

export async function hydrateApiKey(context: ExtensionContext): Promise<void> {
        const apiKey = await context.secrets.get(API_KEY_SECRET_KEY);
        if (apiKey) {
                setApiKey(apiKey);
        }
}

