import * as vscode from 'vscode';

export const MYAI_CONFIGURATION_SECTION = 'myai';
export const MYAI_API_KEY_SECRET = 'myai.apiKey';

export interface MyAISettings {
        readonly enabled: boolean;
        readonly endpoint: string;
        readonly defaultModel: string;
}

const DEFAULT_SETTINGS: Readonly<MyAISettings> = {
        enabled: false,
        endpoint: '',
        defaultModel: 'auto',
};

type MaybePromise<T> = T | Promise<T>;

type MyAIConfigurationChangeListener = (settings: MyAISettings) => MaybePromise<void>;
type MyAISecretChangeListener = (apiKey: string | undefined) => MaybePromise<void>;

function getWorkspaceConfiguration(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration(MYAI_CONFIGURATION_SECTION);
}

export class MyAIConfiguration {
        public constructor(private readonly secretStorage: vscode.SecretStorage) {}

        public get settings(): MyAISettings {
                const configuration = getWorkspaceConfiguration();

                return {
                        enabled: configuration.get<boolean>('enabled', DEFAULT_SETTINGS.enabled),
                        endpoint: configuration.get<string>('endpoint', DEFAULT_SETTINGS.endpoint) ?? DEFAULT_SETTINGS.endpoint,
                        defaultModel: configuration.get<string>('defaultModel', DEFAULT_SETTINGS.defaultModel) ?? DEFAULT_SETTINGS.defaultModel,
                };
        }

        public get enabled(): boolean {
                return this.settings.enabled;
        }

        public get endpoint(): string {
                return this.settings.endpoint;
        }

        public get defaultModel(): string {
                return this.settings.defaultModel;
        }

        public async updateSetting<K extends keyof MyAISettings>(
                key: K,
                value: MyAISettings[K],
                target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
        ): Promise<void> {
                await getWorkspaceConfiguration().update(key, value, target);
        }

        public async getApiKey(): Promise<string | undefined> {
                return this.secretStorage.get(MYAI_API_KEY_SECRET);
        }

        public async setApiKey(value: string | undefined): Promise<void> {
                if (!value) {
                        await this.secretStorage.delete(MYAI_API_KEY_SECRET);
                        return;
                }

                await this.secretStorage.store(MYAI_API_KEY_SECRET, value);
        }

        public onDidChangeConfiguration(listener: MyAIConfigurationChangeListener): vscode.Disposable {
                return vscode.workspace.onDidChangeConfiguration(async (event) => {
                        if (event.affectsConfiguration(MYAI_CONFIGURATION_SECTION)) {
                                await listener(this.settings);
                        }
                });
        }

        public onDidChangeApiKey(listener: MyAISecretChangeListener): vscode.Disposable {
                return this.secretStorage.onDidChange(async (event) => {
                        if (event.key === MYAI_API_KEY_SECRET) {
                                await listener(await this.getApiKey());
                        }
                });
        }
}

export function createMyAIConfiguration(context: vscode.ExtensionContext): MyAIConfiguration {
        return new MyAIConfiguration(context.secrets);
}
