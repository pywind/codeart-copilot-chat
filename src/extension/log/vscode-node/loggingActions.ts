/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as util from 'util';
import * as vscode from 'vscode';

import { RequestType } from '@vscode/copilot-api';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { CAPIClientImpl } from '../../../platform/endpoint/node/capiClientImpl';
import { IEnvService, isScenarioAutomation } from '../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { collectErrorMessages, ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { getRequest, IFetcher } from '../../../platform/networking/common/networking';
import { NodeFetcher } from '../../../platform/networking/node/nodeFetcher';
import { NodeFetchFetcher } from '../../../platform/networking/node/nodeFetchFetcher';
import { ElectronFetcher } from '../../../platform/networking/vscode-node/electronFetcher';
import { FetcherService, getShadowedConfig } from '../../../platform/networking/vscode-node/fetcherServiceImpl';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { createRequestHMAC } from '../../../util/common/crypto';
import { shuffle } from '../../../util/vs/base/common/arrays';
import { timeout } from '../../../util/vs/base/common/async';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { SyncDescriptor } from '../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from '../../../util/vs/platform/instantiation/common/serviceCollection';
import { EXTENSION_ID } from '../../common/constants';

export interface ProxyAgentLog {
	trace(message: string, ...args: any[]): void;
	debug(message: string, ...args: any[]): void;
	info(message: string, ...args: any[]): void;
	warn(message: string, ...args: any[]): void;
	error(message: string | Error, ...args: any[]): void;
}

export class LoggingActionsContrib {
	constructor(
		@IVSCodeExtensionContext private readonly _context: IVSCodeExtensionContext,
		@IEnvService private envService: IEnvService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@ICAPIClientService private readonly capiClientService: ICAPIClientService,
		@IFetcherService private readonly fetcherService: IFetcherService,
		@ILogService private logService: ILogService,
	) {
                this._context.subscriptions.push(vscode.commands.registerCommand('github.copilot.debug.collectDiagnostics', async () => {
                        const document = await vscode.workspace.openTextDocument({ language: 'markdown' });
                        const editor = await vscode.window.showTextDocument(document);
			const electronConfig = getShadowedConfig<boolean>(this.configurationService, this.experimentationService, ConfigKey.Shared.DebugUseElectronFetcher, ConfigKey.Internal.DebugExpUseElectronFetcher);
			const nodeConfig = getShadowedConfig<boolean>(this.configurationService, this.experimentationService, ConfigKey.Shared.DebugUseNodeFetcher, ConfigKey.Internal.DebugExpUseNodeFetcher);
			const nodeFetchConfig = getShadowedConfig<boolean>(this.configurationService, this.experimentationService, ConfigKey.Shared.DebugUseNodeFetchFetcher, ConfigKey.Internal.DebugExpUseNodeFetchFetcher);
			await appendText(editor, `## CodeArt Copilot Chat

- Extension Version: ${this.envService.getVersion()} (${this.envService.getBuildType()})
- VS Code: ${this.envService.getEditorInfo().format()}
- OS: ${this.envService.OS}${vscode.env.remoteName ? `
- Remote Name: ${vscode.env.remoteName}` : ''}

## Network

User Settings:
\`\`\`json${getNonDefaultSettings()}
  "github.copilot.advanced.debug.useElectronFetcher": ${electronConfig},
  "github.copilot.advanced.debug.useNodeFetcher": ${nodeConfig},
  "github.copilot.advanced.debug.useNodeFetchFetcher": ${nodeFetchConfig}
\`\`\`${getProxyEnvVariables()}
`);
			const urls = [
				this.capiClientService.dotcomAPIURL,
				this.capiClientService.capiPingURL,
			];
			const isGHEnterprise = this.capiClientService.dotcomAPIURL !== 'https://api.github.com';
			const timeoutSeconds = 10;
			const electronFetcher = ElectronFetcher.create(this.envService);
			const electronCurrent = !!electronFetcher && electronConfig;
			const nodeCurrent = !electronCurrent && nodeConfig;
			const nodeFetchCurrent = !electronCurrent && !nodeCurrent && nodeFetchConfig;
			const nodeCurrentFallback = !electronCurrent && !nodeFetchCurrent;
			const activeFetcher = this.fetcherService.getUserAgentLibrary();
			const fetchers = {
				['Electron fetch']: {
					fetcher: electronFetcher,
					current: electronCurrent,
				},
                                ['Node.js https']: {
                                        fetcher: new NodeFetcher(this.envService, () => this.configurationService.getConfig(ConfigKey.Shared.DisableStrictSSL)),
					current: nodeCurrent || nodeCurrentFallback,
				},
                                ['Node.js fetch']: {
                                        fetcher: new NodeFetchFetcher(this.envService, () => this.configurationService.getConfig(ConfigKey.Shared.DisableStrictSSL)),
					current: nodeFetchCurrent,
				},
			};
			const dnsLookup = util.promisify(dns.lookup);
			for (const url of urls) {
				const authHeaders: Record<string, string> = {};
				if (isGHEnterprise) {
					let token = '';
					if (url === this.capiClientService.dotcomAPIURL) {
						token = this.authService.anyGitHubSession?.accessToken || '';
					} else {
						try {
							token = (await this.authService.getCopilotToken()).token;
						} catch (_err) {
							// Ignore error
							token = '';
						}
					}
					authHeaders['Authorization'] = `Bearer ${token}`;
				}
				const host = new URL(url).hostname;
				await appendText(editor, `\nConnecting to ${url}:\n`);
				for (const family of [4, 6]) {
					await appendText(editor, `- DNS ipv${family} Lookup: `);
					const start = Date.now();
					try {
						const dnsResult = await Promise.race([dnsLookup(host, { family }), timeout(timeoutSeconds * 1000)]);
						if (dnsResult) {
							await appendText(editor, `${dnsResult.address} (${Date.now() - start} ms)\n`);
						} else {
							await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
						}
					} catch (err) {
						await appendText(editor, `Error (${Date.now() - start} ms): ${err?.message}\n`);
					}
				}
				let probeProxyURL: string | undefined;
				const proxyAgent = loadVSCodeModule<any>('@vscode/proxy-agent');
				if (proxyAgent?.resolveProxyURL) {
					await appendText(editor, `- Proxy URL: `);
					const start = Date.now();
					try {
						const proxyURL = await Promise.race([proxyAgent.resolveProxyURL(url), timeoutAfter(timeoutSeconds * 1000)]);
						if (proxyURL === 'timeout') {
							await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
						} else {
							await appendText(editor, `${proxyURL || 'None'} (${Date.now() - start} ms)\n`);
							probeProxyURL = proxyURL;
						}
					} catch (err) {
						await appendText(editor, `Error (${Date.now() - start} ms): ${err?.message}\n`);
					}
				}
				if (proxyAgent?.loadSystemCertificates && probeProxyURL?.startsWith('https:')) {
					const tlsOrig: typeof tls | undefined = (tls as any).__vscodeOriginal;
					if (tlsOrig) {
						await appendText(editor, `- Proxy TLS: `);
						const osCertificates = await loadSystemCertificates(proxyAgent, this.logService);
						if (!osCertificates) {
							await appendText(editor, `(failed to load system certificates) `);
						}
						const start = Date.now();
						try {
							const result = await Promise.race([tlsConnect(tlsOrig, probeProxyURL, [...tls.rootCertificates, ...(osCertificates || [])]), timeout(timeoutSeconds * 1000)]);
							if (result) {
								await appendText(editor, `${result} (${Date.now() - start} ms)\n`);
							} else {
								await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
							}
						} catch (err) {
							await appendText(editor, `Error (${Date.now() - start} ms): ${err?.message}\n`);
						}
					}
				}
				if (probeProxyURL) {
					const httpx: typeof https | typeof http | undefined = probeProxyURL.startsWith('https:') ? (https as any).__vscodeOriginal : (http as any).__vscodeOriginal;
					if (httpx) {
						await appendText(editor, `- Proxy Connection: `);
						const start = Date.now();
						try {
							const result = await Promise.race([proxyConnect(httpx, probeProxyURL, url), timeout(timeoutSeconds * 1000)]);
							if (result) {
								const headers = Object.keys(result.headers).map(header => `\n	${header}: ${result.headers[header]}`);
								const text = `${result.statusCode} ${result.statusMessage}${headers.join('')}`;
								await appendText(editor, `${text} (${Date.now() - start} ms)\n`);
							} else {
								await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
							}
						} catch (err) {
							await appendText(editor, `Error (${Date.now() - start} ms): ${err?.message}\n`);
						}
					}
				}
				for (const [name, fetcher] of Object.entries(fetchers)) {
					await appendText(editor, `- ${name}${fetcher.current ? ' (configured)' : fetcher.fetcher?.getUserAgentLibrary() === activeFetcher ? ' (active)' : ''}: `);
					if (fetcher.fetcher) {
						const start = Date.now();
						try {
							const response = await Promise.race([fetcher.fetcher.fetch(url, { headers: authHeaders }), timeout(timeoutSeconds * 1000)]);
							if (response) {
								await appendText(editor, `HTTP ${response.status} (${Date.now() - start} ms)\n`);
							} else {
								await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
							}
						} catch (err) {
							await appendText(editor, `Error (${Date.now() - start} ms): ${collectErrorMessages(err)}\n`);
						}
					} else {
						await appendText(editor, 'Unavailable\n');
					}
				}
			}
			await appendText(editor, `
## Documentation

In corporate networks: [Troubleshooting firewall settings for GitHub Copilot](https://docs.github.com/en/copilot/troubleshooting-github-copilot/troubleshooting-firewall-settings-for-github-copilot).`);
                }));

                this._context.subscriptions.push(vscode.commands.registerCommand('github.copilot.chat.configureProxy', async () => {
                        await this.configureProxySettings();
                }));

                this._context.subscriptions.push(vscode.commands.registerCommand('github.copilot.chat.testProxyConnection', async () => {
                        await this.runProxyConnectionTest();
                }));
        }

        private async configureProxySettings(): Promise<void> {
                type ProxyAction = 'proxy' | 'strict' | 'test' | 'done';
                let continueConfig = true;
                while (continueConfig) {
                        const disableStrictSSL = this.configurationService.getConfig(ConfigKey.Shared.DisableStrictSSL);
                        const proxyUrl = this.configurationService.getConfig(ConfigKey.Shared.DebugOverrideProxyUrl) ?? '';
                        const items: (vscode.QuickPickItem & { id: ProxyAction })[] = [
                                {
                                        id: 'proxy',
                                        label: vscode.l10n.t('Set Copilot proxy URL'),
                                        description: proxyUrl ? proxyUrl : vscode.l10n.t('Not configured'),
                                },
                                {
                                        id: 'strict',
                                        label: disableStrictSSL ? vscode.l10n.t('Enable strict SSL validation') : vscode.l10n.t('Disable strict SSL validation'),
                                        description: disableStrictSSL ? vscode.l10n.t('Currently disabled') : vscode.l10n.t('Currently enabled'),
                                        detail: disableStrictSSL ? undefined : vscode.l10n.t('Not recommended unless Copilot must trust a custom proxy certificate.'),
                                },
                                {
                                        id: 'test',
                                        label: vscode.l10n.t('Test Copilot connection'),
                                        description: vscode.l10n.t('Verify connectivity using the current proxy settings'),
                                },
                                {
                                        id: 'done',
                                        label: vscode.l10n.t('Done'),
                                }
                        ];

                        const selection = await vscode.window.showQuickPick(items, {
                                placeHolder: vscode.l10n.t('Configure Copilot network overrides'),
                        });

                        if (!selection) {
                                continueConfig = false;
                                break;
                        }

                        switch (selection.id) {
                                case 'proxy': {
                                        const newValue = await vscode.window.showInputBox({
                                                title: vscode.l10n.t('Copilot proxy URL'),
                                                prompt: vscode.l10n.t('Enter the proxy that Copilot should use (leave empty to reset).'),
                                                placeHolder: 'https://proxy.example.com:3128',
                                                ignoreFocusLost: true,
                                                value: proxyUrl,
                                                validateInput: value => this.validateProxyUrl(value),
                                        });
                                        if (newValue !== undefined) {
                                                const trimmed = newValue.trim();
                                                await this.configurationService.updateValue(ConfigKey.Shared.DebugOverrideProxyUrl.fullyQualifiedId, trimmed ? trimmed : undefined, vscode.ConfigurationTarget.Global);
                                                this.logService.info(`[network] Copilot proxy URL ${trimmed ? 'set' : 'cleared'}.`);
                                        }
                                        break;
                                }
                                case 'strict': {
                                        if (!disableStrictSSL) {
                                                const disableLabel = vscode.l10n.t('Disable strict SSL');
                                                const warningResult = await vscode.window.showWarningMessage(
                                                        vscode.l10n.t('Disabling strict SSL allows Copilot to ignore certificate errors when connecting through the configured proxy.'),
                                                        { modal: true, detail: vscode.l10n.t('Only disable this option for proxies you control and trust.') },
                                                        disableLabel,
                                                        vscode.l10n.t('Cancel'),
                                                );
                                                if (warningResult === disableLabel) {
                                                        await this.configurationService.updateValue(ConfigKey.Shared.DisableStrictSSL.fullyQualifiedId, true, vscode.ConfigurationTarget.Global);
                                                        this.logService.warn('[network] Strict SSL disabled for Copilot requests.');
                                                        vscode.window.showInformationMessage(vscode.l10n.t('Strict SSL has been disabled for Copilot network requests.'));
                                                }
                                        } else {
                                                await this.configurationService.updateValue(ConfigKey.Shared.DisableStrictSSL.fullyQualifiedId, false, vscode.ConfigurationTarget.Global);
                                                this.logService.info('[network] Strict SSL re-enabled for Copilot requests.');
                                                vscode.window.showInformationMessage(vscode.l10n.t('Strict SSL has been re-enabled for Copilot network requests.'));
                                        }
                                        break;
                                }
                                case 'test':
                                        await this.runProxyConnectionTest();
                                        break;
                                case 'done':
                                        continueConfig = false;
                                        break;
                        }
                }
        }

        private async runProxyConnectionTest(): Promise<void> {
                const target = this.capiClientService.capiPingURL;
                try {
                        const outcome = await vscode.window.withProgress<{ ok: boolean; status: number; statusText: string; elapsed: number }>(
                                {
                                        location: vscode.ProgressLocation.Notification,
                                        title: vscode.l10n.t('Testing Copilot connection...'),
                                },
                                async () => {
                                        const start = Date.now();
                                        const response = await this.fetcherService.fetch(target, { method: 'GET' });
                                        const elapsed = Date.now() - start;
                                        return { ok: response.status >= 200 && response.status < 300, status: response.status, statusText: response.statusText, elapsed };
                                }
                        );

                        const proxyUrl = this.configurationService.getConfig(ConfigKey.Shared.DebugOverrideProxyUrl);
                        const proxyLabel = proxyUrl ? proxyUrl : vscode.l10n.t('system proxy settings');
                        if (outcome.ok) {
                                vscode.window.showInformationMessage(vscode.l10n.t('Successfully reached Copilot in {0} ms using {1}.', outcome.elapsed, proxyLabel));
                        } else {
                                vscode.window.showErrorMessage(vscode.l10n.t('Copilot responded with HTTP {0} ({1}) when using {2}.', outcome.status, outcome.statusText, proxyLabel));
                        }
                } catch (err) {
                        this.logService.error(err);
                        const message = collectErrorMessages(err);
                        vscode.window.showErrorMessage(vscode.l10n.t('Proxy test failed: {0}', message));
                }
        }

        private validateProxyUrl(value: string): string | undefined {
                const trimmed = value.trim();
                if (!trimmed) {
                        return undefined;
                }
                try {
                        const parsed = new URL(trimmed);
                        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                                return vscode.l10n.t('Only HTTP or HTTPS proxy URLs are supported.');
                        }
                        if (!parsed.hostname) {
                                return vscode.l10n.t('Proxy URL must include a hostname.');
                        }
                } catch (_err) {
                        return vscode.l10n.t('Enter a valid URL such as https://proxy.example.com:3128.');
                }
                return undefined;
        }
}

async function appendText(editor: vscode.TextEditor, string: string) {
	await editor.edit(builder => {
		builder.insert(editor.document.lineAt(editor.document.lineCount - 1).range.end, string);
	});
}

function timeoutAfter(ms: number) {
	return new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms));
}

function loadVSCodeModule<T>(moduleName: string): T | undefined {
	const appRoot = vscode.env.appRoot;
	try {
		return require(`${appRoot}/node_modules.asar/${moduleName}`);
	} catch (err) {
		// Not in ASAR.
	}
	try {
		return require(`${appRoot}/node_modules/${moduleName}`);
	} catch (err) {
		// Not available.
	}
	return undefined;
}

async function loadSystemCertificates(proxyAgent: any, logService: ILogService): Promise<(string | Buffer)[] | undefined> {
	try {
		const certificates = await proxyAgent.loadSystemCertificates({
			log: {
				trace(message: string, ..._args: any[]) {
					logService.trace(message);
				},
				debug(message: string, ..._args: any[]) {
					logService.debug(message);
				},
				info(message: string, ..._args: any[]) {
					logService.info(message);
				},
				warn(message: string, ..._args: any[]) {
					logService.warn(message);
				},
				error(message: string | Error, ..._args: any[]) {
					logService.error(typeof message === 'string' ? message : String(message));
				},
			} satisfies ProxyAgentLog
		});
		return Array.isArray(certificates) ? certificates : undefined;
	} catch (err) {
		logService.error(err);
		return undefined;
	}
}

async function tlsConnect(tlsOrig: typeof tls, proxyURL: string, ca: (string | Buffer)[]) {
	return new Promise<string>((resolve, reject) => {
		const proxyUrlObj = new URL(proxyURL);
		const socket = tlsOrig.connect({
			host: proxyUrlObj.hostname,
			port: parseInt(proxyUrlObj.port, 10),
			servername: proxyUrlObj.hostname,
			ca,
		}, () => {
			socket.end();
			resolve('Succeeded');
		});
		socket.on('error', reject);
	});
}

async function proxyConnect(httpx: typeof https | typeof http, proxyUrl: string, targetUrl: string, sanitize = false) {
	return new Promise<{ statusCode: number | undefined; statusMessage: string | undefined; headers: Record<string, string | string[]> }>((resolve, reject) => {
		const proxyUrlObj = new URL(proxyUrl);
		const targetUrlObj = new URL(targetUrl);
		const targetHost = `${targetUrlObj.hostname}:${targetUrlObj.port || (targetUrlObj.protocol === 'https:' ? 443 : 80)}`;
		const options = {
			method: 'CONNECT',
			host: proxyUrlObj.hostname,
			port: proxyUrlObj.port,
			path: targetHost,
			headers: {
				Host: targetHost,
			},
			rejectUnauthorized: false,
		};
		const req = httpx.request(options);
		req.on('connect', (res, socket, head) => {
			const headers = ['proxy-authenticate', 'proxy-agent', 'server', 'via'].reduce((acc, header) => {
				const value = res.headers[header];
				if (value) {
					const doSanitize = sanitize && !['proxy-agent', 'server'].includes(header);
					acc[header] = doSanitize ? Array.isArray(value) ? value.map(sanitizeValue) : sanitizeValue(value) : value;
				}
				return acc;
			}, {} as Record<string, string | string[]>);
			socket.end();
			resolve({ statusCode: res.statusCode, statusMessage: res.statusMessage, headers });
		});
		req.on('error', reject);
		req.end();
	});
}

function getNonDefaultSettings() {
	const configuration = vscode.workspace.getConfiguration();
	return [
		'http.proxy',
		'http.noProxy',
		'http.proxyAuthorization',
		'http.proxyStrictSSL',
		'http.proxySupport',
		'http.electronFetch',
		'http.fetchAdditionalSupport',
		'http.proxyKerberosServicePrincipal',
		'http.systemCertificates',
		'http.experimental.systemCertificatesV2',
	].map(key => {
		const i = configuration.inspect(key);
		const v = configuration.get(key, i?.defaultValue);
		if (v !== i?.defaultValue && !(Array.isArray(v) && Array.isArray(i?.defaultValue) && v.length === 0 && i?.defaultValue.length === 0)) {
			return `\n  "${key}": ${JSON.stringify(v)},`;
		}
		return '';
	}).join('');
}

function getProxyEnvVariables() {
	const res = [];
	const envVars = ['http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy', 'no_proxy'];
	for (const env in process.env) {
		if (envVars.includes(env.toLowerCase())) {
			res.push(`\n- ${env}=${process.env[env]}`);
		}
	}
	return res.length ? `\n\nEnvironment Variables:${res.join('')}` : '';
}

export function collectFetcherTelemetry(accessor: ServicesAccessor, error: any): void {
	const extensionContext = accessor.get(IVSCodeExtensionContext);
	const fetcherService = accessor.get(IFetcherService);
	const envService = accessor.get(IEnvService);
	const telemetryService = accessor.get(ITelemetryService);
	const logService = accessor.get(ILogService);
	const authService = accessor.get(IAuthenticationService);
	const configurationService = accessor.get(IConfigurationService);
	const expService = accessor.get(IExperimentationService);
	const capiClientService = accessor.get(ICAPIClientService);
	const instantiationService = accessor.get(IInstantiationService);
	if (extensionContext.extensionMode === vscode.ExtensionMode.Test || isScenarioAutomation) {
		return;
	}

	if (!configurationService.getExperimentBasedConfig(ConfigKey.Internal.DebugCollectFetcherTelemetry, expService)) {
		return;
	}

	const now = Date.now();
	const previous = extensionContext.globalState.get<number>('lastCollectFetcherTelemetryTime', 0);
	const isInsiders = vscode.env.appName.includes('Insiders');
	const hours = isInsiders ? 5 : 26;
	if (now - previous < hours * 60 * 60 * 1000) {
		logService.debug(`Refetch model metadata: Skipped.`);
		return;
	}

	(async () => {
		await extensionContext.globalState.update('lastCollectFetcherTelemetryTime', now);

		logService.debug(`Refetch model metadata: Exclude other windows.`);
		const windowUUID = generateUuid();
		await extensionContext.globalState.update('lastCollectFetcherTelemetryUUID', windowUUID);
		await timeout(5000);
		if (extensionContext.globalState.get<string>('lastCollectFetcherTelemetryUUID') !== windowUUID) {
			logService.debug(`Refetch model metadata: Other window won.`);
			return;
		}
		logService.debug(`Refetch model metadata: This window won.`);

		const proxy = await findProxyInfo(capiClientService);

		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		const extKind = (ext ? ext.extensionKind === vscode.ExtensionKind.UI : !vscode.env.remoteName) ? 'local' : 'remote';
		const remoteName = sanitizeValue(vscode.env.remoteName) || 'none';
		const platform = process.platform;
		const originalLibrary = fetcherService.getUserAgentLibrary();
		const originalError = error ? (sanitizeValue(error.message) || 'unknown') : 'none';
		const userAgentLibraryUpdate = (library: string) => JSON.stringify({ extKind, remoteName, platform, library, originalLibrary, originalError, proxy });
		const fetchers = [
			ElectronFetcher.create(envService, userAgentLibraryUpdate),
			new NodeFetchFetcher(envService, userAgentLibraryUpdate),
                        new NodeFetcher(envService, () => this.configurationService.getConfig(ConfigKey.Shared.DisableStrictSSL), userAgentLibraryUpdate),
		].filter(fetcher => fetcher) as IFetcher[];

		// Randomize to offset any order dependency in telemetry.
		shuffle(fetchers);

		for (const fetcher of fetchers) {
			const requestId = generateUuid();
			const copilotToken = (await authService.getCopilotToken()).token;
			const requestStartTime = Date.now();
			const modifiedInstaService = instantiationService.createChild(new ServiceCollection(
				[IFetcherService, new SyncDescriptor(FetcherService, [fetcher])],
			));
			try {
				const modifiedCapiClientService = modifiedInstaService.createInstance(CAPIClientImpl);
				const response = await getRequest(
					fetcher,
					telemetryService,
					modifiedCapiClientService,
					{ type: RequestType.Models },
					copilotToken,
					await createRequestHMAC(process.env.HMAC_SECRET),
					'model-access',
					requestId,
				);

				if (response.status < 200 || response.status >= 300) {
					await response.text();
				} else {
					await response.json();
				}

				logService.info(`Refetch model metadata: Succeeded in ${Date.now() - requestStartTime}ms ${requestId} (${response.headers.get('x-github-request-id')}) using ${fetcher.getUserAgentLibrary()} with status ${response.status}.`);
			} catch (e) {
				logService.info(`Refetch model metadata: Failed in ${Date.now() - requestStartTime}ms ${requestId} using ${fetcher.getUserAgentLibrary()}.`);
			} finally {
				modifiedInstaService.dispose();
			}
		}
	})().catch(err => {
		logService.error(err);
	});
}

async function findProxyInfo(capiClientService: ICAPIClientService) {
	const timeoutSeconds = 5;
	let proxy: { status: string;[key: string]: any };
	try {
		const proxyAgent = loadVSCodeModule<any>('@vscode/proxy-agent');
		if (proxyAgent?.resolveProxyURL) {
			const url = capiClientService.capiPingURL; // Assuming this gets the same proxy as for the models request.
			const proxyURL = await Promise.race([proxyAgent.resolveProxyURL(url), timeoutAfter(timeoutSeconds * 1000)]);
			if (proxyURL === 'timeout') {
				proxy = { status: 'resolveProxyURL timeout' };
			} else if (proxyURL) {
				const httpx: typeof https | typeof http | undefined = proxyURL.startsWith('https:') ? (https as any).__vscodeOriginal : (http as any).__vscodeOriginal;
				if (httpx) {
					const result = await Promise.race([proxyConnect(httpx, proxyURL, url, true), timeout(timeoutSeconds * 1000)]);
					if (result) {
						proxy = { status: 'success', ...result };
					} else {
						proxy = { status: 'proxyConnect timeout' };
					}
				} else {
					proxy = { status: 'no original http/s module' };
				}
			} else {
				proxy = { status: 'no proxy' };
			}
		} else {
			proxy = { status: 'no resolveProxyURL' };
		}
	} catch (err) {
		proxy = { status: 'error', message: sanitizeValue(err?.message) };
	}
	return proxy;
}

const ids_paths = /(^|\b)[\p{L}\p{Nd}]+((=""?[^"]+""?)|(([.:=/"_-]+[\p{L}\p{Nd}]+)+))(\b|$)/giu;
export function sanitizeValue(input: string | undefined): string {
	return (input || '').replace(ids_paths, (m) => maskByClass(m));
}

function maskByClass(s: string): string {
	if (/^net::[A-Z_]+$/.test(s) || ['dev-container', 'attached-container', 'k8s-container', 'ssh-remote'].includes(s)) {
		return s;
	}
	return s.replace(/\p{Lu}|\p{Ll}|\p{Nd}/gu, (ch) => {
		if (/\p{Lu}/u.test(ch)) {
			return 'A';
		}
		if (/\p{Ll}/u.test(ch)) {
			return 'a';
		}
		return '0';
	});
}
