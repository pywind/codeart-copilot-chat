/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, ExtensionContext } from 'vscode';
import { readFileSync } from 'fs';
import { join } from 'path';

interface PackageJson {
        contributes?: {
                commands?: Array<{ command?: unknown }>;
        };
}

export function registerCodeArtCommandAliases(context: ExtensionContext) {
        const packageJsonPath = join(context.extensionPath, 'package.json');
        let contributes: PackageJson['contributes'];
        try {
                const raw = readFileSync(packageJsonPath, 'utf8');
                const parsed = JSON.parse(raw) as PackageJson;
                contributes = parsed.contributes;
        } catch (error) {
                console.error('Failed to load command aliases from package.json', error);
                return;
        }

        const commandsList = contributes?.commands;
        if (!Array.isArray(commandsList)) {
                return;
        }

        for (const entry of commandsList) {
                const commandId = typeof entry?.command === 'string' ? entry.command : undefined;
                if (!commandId || !commandId.startsWith('codeart.studio.')) {
                        continue;
                }

                const legacyId = commandId.replace('codeart.studio.', 'github.copilot.');
                if (legacyId === commandId) {
                        continue;
                }

                const disposable = commands.registerCommand(commandId, (...args: unknown[]) => {
                        return commands.executeCommand(legacyId, ...args);
                });
                context.subscriptions.push(disposable);
        }
}
