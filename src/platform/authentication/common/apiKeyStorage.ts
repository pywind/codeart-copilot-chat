/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../util/vs/base/common/event';

let cachedApiKey: string | undefined;

const apiKeyChangeEmitter = new Emitter<void>();

export const onDidChangeApiKey: Event<void> = apiKeyChangeEmitter.event;

export function setApiKey(apiKey: string | undefined): void {
        if (cachedApiKey === apiKey) {
                return;
        }
        cachedApiKey = apiKey;
        apiKeyChangeEmitter.fire();
}

export function getApiKey(): string | undefined {
        return cachedApiKey;
}

