/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as undici from 'undici';
import { IEnvService } from '../../env/common/envService';
import { BaseFetchFetcher } from './baseFetchFetcher';
import { Lazy } from '../../../util/vs/base/common/lazy';

export class NodeFetchFetcher extends BaseFetchFetcher {

        constructor(
                envService: IEnvService,
                shouldDisableStrictSSL?: () => boolean,
                userAgentLibraryUpdate?: (original: string) => string,
        ) {
                super(createFetch(shouldDisableStrictSSL), envService, userAgentLibraryUpdate);
        }

	getUserAgentLibrary(): string {
		return 'node-fetch';
	}

	isInternetDisconnectedError(_e: any): boolean {
		return false;
	}
	isFetcherError(e: any): boolean {
		const code = e?.code || e?.cause?.code;
		return code && ['EADDRINUSE', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT'].includes(code);
	}
}

function createFetch(shouldDisableStrictSSL?: () => boolean): typeof globalThis.fetch {
        const fetch = (globalThis as any).__vscodePatchedFetch || globalThis.fetch;
        const strictAgent = new Lazy(() => new undici.Agent({ allowH2: true }));
        const insecureAgent = new Lazy(() => new undici.Agent({ allowH2: true, connect: { rejectUnauthorized: false } }));
        return function (input: string | URL | globalThis.Request, init?: RequestInit) {
                const dispatcher = shouldDisableStrictSSL?.() ? insecureAgent.value : strictAgent.value;
                return fetch(input, { dispatcher, ...init });
        };
}
