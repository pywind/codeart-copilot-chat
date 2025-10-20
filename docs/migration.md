# Migration guide: GitHub Copilot Chat to CodeArt Copilot Chat

This guide explains how to move from the Marketplace version of **GitHub Copilot Chat** to the **CodeArt Copilot Chat** fork and keep your workflow running smoothly.

## 1. Understand what's changing

CodeArt Copilot Chat is a community-maintained fork of the official GitHub Copilot Chat extension. It keeps the overall feature set and uses the same GitHub Copilot service, but it removes Microsoft-operated telemetry and can be updated independently of the Marketplace listing.

Your existing **GitHub Copilot** inline-completion extension can remain installed. Only the chat companion extension is replaced.

### API key requirements

* **No additional API key is required** to continue using GitHub-hosted Copilot models. You still need to sign in with a GitHub account that has an active Copilot plan, exactly as before.
* CodeArt Copilot Chat also supports *bring your own key (BYOK)* providers such as OpenAI-compatible services, Anthropic, Azure OpenAI, Gemini, and others. These integrations **do** require you to supply the provider's API key (or deployment credentials) through the extension's settings when you opt in to those models.

## 2. Prepare VS Code

1. Open VS Code and go to the **Extensions** view.
2. Locate **GitHub Copilot Chat** (publisher: GitHub) and uninstall it. This avoids conflicts because both extensions contribute the same views and commands.
3. (Optional) Disable automatic updates for the remaining GitHub Copilot extension if you want to pin to a specific version while testing the fork.

All of your `github.copilot.*` settings are stored in your VS Code settings and will be picked up automatically after installing the fork.

## 3. Install CodeArt Copilot Chat

### Option A – use published VSIX builds

1. Download the latest `codeart-copilot-chat-stable.vsix` (or the `-insiders` build if you want pre-release updates) from the repository's releases or workflow artifacts.
2. In VS Code, open the command palette and run **Extensions: Install from VSIX...**.
3. Select the downloaded file and restart VS Code when prompted.

### Option B – build the VSIX locally

1. Clone this repository and install dependencies:

   ```bash
   npm install
   ```

2. Package the desired channel:

   ```bash
   # Stable channel build
   npm run package:stable

   # Insiders (pre-release) build
   npm run package:insiders
   ```

   Each command creates a `.vsix` in the `build/` folder that you can install through **Extensions: Install from VSIX...**.

## 4. Sign in and verify

1. After the extension reloads, use any Copilot command (for example, open the **Copilot** chat view) and sign in with your GitHub account if prompted.
2. Confirm that chat responses work as expected.
3. If you plan to use BYOK providers, open **Settings ▸ GitHub Copilot ▸ Chat ▸ Language Models** and configure the required API keys or endpoints.

## 5. Troubleshooting

* If VS Code reports that Copilot features are unavailable, sign out and sign back in via the **Accounts** menu.
* When updating to new releases of the fork, repeat the installation process with the newer VSIX. You can have stable and insiders VSIX files side-by-side, but only one can be installed at a time.
* For build issues, make sure you are using the Node.js and npm versions listed in the repository's [`engines`](../package.json) field.

## Need help?

File an issue in the repository with logs from **Help ▸ Toggle Developer Tools** or the **GitHub Copilot** output channel so maintainers can investigate.
