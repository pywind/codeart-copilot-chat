# CodeArt Studio Chat – Your AI coding partner

CodeArt Studio Chat packages the chat, agent, and inline assistance pieces from the open source Copilot Chat fork under a community friendly brand. The experience stays fully compatible with upstream Copilot services while avoiding proprietary artwork, product names, or marketing copy.

## Why choose CodeArt Studio Chat?

- **Stay focused inside VS Code.** Iterate on multi-file edits, ask questions about unfamiliar code, or run quick experiments without leaving the editor.
- **Pick the workflow that fits.** Launch autonomous agent sessions for multi-step tasks, switch to collaborative edit mode for guided refactors, or use inline chat for quick fixes.
- **Bring your own backend.** Point the extension at any Copilot-compatible service endpoint, including self-hosted deployments.
- **Transparent by design.** This fork removes telemetry hooks and keeps all prompts, logs, and credentials on your machine.

## Getting started

1. Install the **CodeArt Studio Chat** VSIX you built from this repository.
2. Sign in with the Copilot-compatible provider that your organization or instance exposes.
3. Open the **Chat** view in VS Code to start a conversation, kick off an agent workflow, or invoke inline chat.

## Feature highlights

### AI-powered coding sessions

Launch an AI session that understands your workspace. Agent workflows can run builds, execute tests, and iterate until tasks succeed. Edit mode keeps you in control with conversational, stepwise changes applied directly to your files.

### Code suggestions in the editor

Inline chat and next edit suggestions surface code changes as you type. Accept updates with the Tab key or trigger follow-up instructions from the inline UI when you need more context.

### Ask and learn about your code with chat

Ask questions about the files you have open, explore APIs, or request explanations for complex logic. Workspace-aware context, slash commands, and participants help responses stay grounded in your repository.

## Requirements

- **Node.js** `>= 22.14.0` and **npm** `>= 9.0.0`
- **Visual Studio Code** `1.106.0` or newer
- Platform build tools required by Node.js (Python and C/C++ tooling on Windows)

## Building and running from source

1. Clone this repository and open it in VS Code.
2. Install dependencies with `npm install`.
3. Run `npm run compile` for a development build with source maps, or `npm run build` for a production bundle.
4. Start the **Run Extension** launch configuration (or run `code --extensionDevelopmentPath="$(pwd)"`) to load the extension in an Extension Development Host.
5. To publish a VSIX package, run `npm run package` and look in the `build/` directory for the output.

## Resources

- [Project documentation](docs/README.md)
- [Issue tracker](https://github.com/codeart-ai/codeart-copilot-chat/issues)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## License

Copyright (c) 2024 CodeArt Collective.

Licensed under the [MIT](LICENSE.txt) license.
