/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestMetadata } from '@vscode/copilot-api';
import { Raw } from '@vscode/prompt-tsx';
import * as http from 'http';
import { ClientHttp2Stream } from 'http2';
import OpenAI from 'openai';
import { IChatMLFetcher, Source } from '../../../platform/chat/common/chatMLFetcher';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { CustomModel, EndpointEditToolName, IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { responseApiInputToRawMessagesForLogging } from '../../../platform/endpoint/node/responsesApi';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, OptionalChatRequestParams, getRequestId } from '../../../platform/networking/common/fetch';
import { Response } from '../../../platform/networking/common/fetcherService';
import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody, IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { ChatCompletion, FinishedCompletionReason } from '../../../platform/networking/common/openai';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { ITokenizer, TokenizerType } from '../../../util/common/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';

export interface ILanguageModelServerConfig {
	readonly port: number;
	readonly nonce: string;
}

/**
 * HTTP server that provides an OpenAI Responses API compatible endpoint.
 * Acts as a pure pass-through proxy to the underlying model endpoint.
 */
export class OpenAILanguageModelServer extends Disposable {
	private server: http.Server;
	private config: ILanguageModelServerConfig;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.config = {
			port: 0, // Will be set to random available port
			nonce: 'vscode-lm-' + generateUuid()
		};

		this.server = this.createServer();
		this._register(toDisposable(() => this.stop()));
	}

	private createServer(): http.Server {
		return http.createServer(async (req, res) => {
			this.logService.trace(`Received request: ${req.method} ${req.url}`);

			if (req.method === 'OPTIONS') {
				res.writeHead(200);
				res.end();
				return;
			}

			// It sends //responses if OPENAI_BASE_URL ends in /
			if (req.method === 'POST' && (req.url === '/v1/responses' || req.url === '/responses' || req.url === '//responses')) {
				try {
					const body = await this.readRequestBody(req);

					// Verify nonce for authentication
					const authHeader = req.headers.authorization;
					const bearerSpace = 'Bearer ';
					const authKey = authHeader?.startsWith(bearerSpace) ? authHeader.substring(bearerSpace.length) : undefined;
					if (authKey !== this.config.nonce) {
						this.logService.trace(`[LanguageModelServer] Invalid auth key`);
						res.writeHead(401, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: 'Invalid authentication' }));
						return;
					}

					await this.handleResponsesAPIRequest(body, res);
				} catch (error) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({
						error: 'Internal server error',
						details: error instanceof Error ? error.message : String(error)
					}));
				}
				return;
			}

			if (req.method === 'GET' && req.url === '/') {
				res.writeHead(200);
				res.end('Hello from LanguageModelServer');
				return;
			}

			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not found' }));
		});
	}

	private async readRequestBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let body = '';
			req.on('data', chunk => {
				body += chunk.toString();
			});
			req.on('end', () => {
				resolve(body);
			});
			req.on('error', reject);
		});
	}

	private async handleResponsesAPIRequest(bodyString: string, res: http.ServerResponse): Promise<void> {
		// Create cancellation token for the request
		const tokenSource = new CancellationTokenSource();

		try {
			// Weird type but ok
			const requestBody: OpenAI.Responses.ResponseCreateParams = JSON.parse(bodyString);
			const lastMessage = requestBody.input?.at(-1);
			const isUserInitiatedMessage = typeof lastMessage === 'string' ||
				lastMessage?.type === 'message' && lastMessage.role === 'user';

			const endpoints = await this.endpointProvider.getAllChatEndpoints();

			if (endpoints.length === 0) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'No language models available' }));
				return;
			}

			const selectedEndpoint = this.selectEndpoint(endpoints, requestBody.model);
			if (!selectedEndpoint) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					error: 'No model found matching criteria'
				}));
				return;
			}

			// Set up streaming response
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
			});

			// Handle client disconnect
			let requestComplete = false;
			res.on('close', () => {
				if (!requestComplete) {
					this.logService.info(`[LanguageModelServer] Client disconnected before request complete`);
				}

				tokenSource.cancel();
			});

			const endpointRequestBody = requestBody as IEndpointBody;
			const streamingEndpoint = this.instantiationService.createInstance(StreamingPassThroughEndpoint, selectedEndpoint, res, endpointRequestBody);

			await streamingEndpoint.makeChatRequest2({
				debugName: 'oaiLMServer',
				messages: Array.isArray(requestBody.input) ?
					responseApiInputToRawMessagesForLogging(requestBody) :
					[],
				finishedCb: async () => undefined,
				location: ChatLocation.Agent,
				userInitiatedRequest: isUserInitiatedMessage
			}, tokenSource.token);

			requestComplete = true;

			res.end();
		} catch (error) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: 'Failed to process chat request',
				details: error instanceof Error ? error.message : String(error)
			}));
		} finally {
			tokenSource.dispose();
		}
	}

	private selectEndpoint(endpoints: readonly IChatEndpoint[], requestedModel?: string): IChatEndpoint | undefined {
		if (requestedModel) {
			// Try to find exact match first
			const selectedEndpoint = endpoints.find(e => e.family === requestedModel);
			return selectedEndpoint;
		}

		// Use first available model if no criteria specified
		return endpoints[0];
	}

	public async start(): Promise<void> {
		if (this.config.port !== 0) {
			// Already started
			return;
		}

		return new Promise((resolve, reject) => {
			this.server.listen(0, '127.0.0.1', () => {
				const address = this.server.address();
				if (address && typeof address === 'object') {
					this.config = {
						...this.config,
						port: address.port
					};
					this.logService.trace(`Language Model Server started on http://localhost:${this.config.port}`);
					resolve();
					return;
				}

				reject(new Error('Failed to start server'));
			});
		});
	}

	public stop(): void {
		this.server.close();
	}

	public getConfig(): ILanguageModelServerConfig {
		return { ...this.config };
	}
}

class StreamingPassThroughEndpoint implements IChatEndpoint {
	constructor(
		private readonly base: IChatEndpoint,
		private readonly responseStream: http.ServerResponse,
		private readonly requestBody: IEndpointBody,
		@IChatMLFetcher private readonly chatMLFetcher: IChatMLFetcher
	) { }

	public get urlOrRequestMetadata(): string | RequestMetadata {
		return this.base.urlOrRequestMetadata;
	}

	public getExtraHeaders(): Record<string, string> {
		return this.base.getExtraHeaders?.() ?? {};
	}

	public interceptBody(body: IEndpointBody | undefined): void {
		this.base.interceptBody?.(body);
	}

	public acquireTokenizer(): ITokenizer {
		return this.base.acquireTokenizer();
	}

	public get modelMaxPromptTokens(): number {
		return this.base.modelMaxPromptTokens;
	}

	public get maxOutputTokens(): number {
		return this.base.maxOutputTokens;
	}

	public get model(): string {
		return this.base.model;
	}

	public get name(): string {
		return this.base.name;
	}

	public get version(): string {
		return this.base.version;
	}

	public get family(): string {
		return this.base.family;
	}

	public get tokenizer(): TokenizerType {
		return this.base.tokenizer;
	}

	public get showInModelPicker(): boolean {
		return this.base.showInModelPicker;
	}

	public get isPremium(): boolean | undefined {
		return this.base.isPremium;
	}

	public get degradationReason(): string | undefined {
		return this.base.degradationReason;
	}

	public get multiplier(): number | undefined {
		return this.base.multiplier;
	}

	public get restrictedToSkus(): string[] | undefined {
		return this.base.restrictedToSkus;
	}

	public get isDefault(): boolean {
		return this.base.isDefault;
	}

	public get isFallback(): boolean {
		return this.base.isFallback;
	}

	public get customModel(): CustomModel | undefined {
		return this.base.customModel;
	}

	public get isExtensionContributed(): boolean | undefined {
		return this.base.isExtensionContributed;
	}

	public get apiType(): string | undefined {
		return this.base.apiType;
	}

	public get supportsThinkingContentInHistory(): boolean | undefined {
		return this.base.supportsThinkingContentInHistory;
	}

	public get supportsToolCalls(): boolean {
		return this.base.supportsToolCalls;
	}

        public get supportsVision(): boolean {
                return this.base.supportsVision;
        }

        public get supportsPrediction(): boolean {
                return this.base.supportsPrediction;
        }

        public get supportsThinking(): boolean {
                return this.base.supportsThinking;
        }

	public get supportedEditTools(): readonly EndpointEditToolName[] | undefined {
		return this.base.supportedEditTools;
	}

	public get policy(): IChatEndpoint['policy'] {
		return this.base.policy;
	}

	public async processResponseFromChatEndpoint(
		telemetryService: ITelemetryService,
		logService: ILogService,
		response: Response,
		expectedNumChoices: number,
		finishCallback: FinishedCallback,
		telemetryData: TelemetryData,
		cancellationToken?: CancellationToken
	): Promise<AsyncIterableObject<ChatCompletion>> {
		const body = (await response.body()) as ClientHttp2Stream;

		try {
			for await (const chunk of body) {
				logService.trace(`[StreamingPassThroughEndpoint] chunk: ${chunk.toString()}`);
				if (cancellationToken?.isCancellationRequested) {
					break;
				}

				this.responseStream.write(chunk);
			}
		} finally {
			if (!body.destroyed) {
				body.destroy();
			}
		}

		const requestId = getRequestId(response);
		const completionMessage: Raw.AssistantChatMessage = {
			role: Raw.ChatRole.Assistant,
			content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: '' }]
		};

		const completion: ChatCompletion = {
			message: completionMessage,
			choiceIndex: 0,
			requestId,
			tokens: [],
			usage: undefined,
			blockFinished: true,
			finishReason: FinishedCompletionReason.Stop,
			telemetryData
		};

		return AsyncIterableObject.fromArray([completion]);
	}

	public acceptChatPolicy(): Promise<boolean> {
		return this.base.acceptChatPolicy();
	}

	public makeChatRequest(
		debugName: string,
		messages: Raw.ChatMessage[],
		finishedCb: FinishedCallback | undefined,
		token: CancellationToken,
		location: ChatLocation,
		source?: Source,
		requestOptions?: Omit<OptionalChatRequestParams, 'n'>,
		userInitiatedRequest?: boolean
	): Promise<ChatResponse> {
		throw new Error('not implemented');
	}

	public makeChatRequest2(
		options: IMakeChatRequestOptions,
		token: CancellationToken
	): Promise<ChatResponse> {
		return this.chatMLFetcher.fetchOne({
			requestOptions: {},
			...options,
			endpoint: this,
		}, token);
	}

	public createRequestBody(
		options: ICreateEndpointBodyOptions
	): IEndpointBody {
		return this.requestBody;
	}

	public cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		throw new Error('not implemented');
	}
}