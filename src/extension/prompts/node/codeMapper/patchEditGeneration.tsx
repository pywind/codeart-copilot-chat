/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement } from '@vscode/prompt-tsx';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
import { URI } from '../../../../util/vs/base/common/uri';
import { TextEdit, Uri } from '../../../../vscodeTypes';
import { OutcomeAnnotation, OutcomeAnnotationLabel } from '../../../inlineChat/node/promptCraftingTypes';
import { Lines, LinesEdit } from '../../../prompt/node/editGeneration';
import { Reporter, createEditsFromRealDiff } from '../../../prompt/node/editFromDiffGeneration';
import { CodeBlock } from '../panel/safeElements';

const APPLY_PATCH_BEGIN = '*** Begin Patch';
const APPLY_PATCH_END = '*** End Patch';
const UPDATE_FILE_PREFIX = '*** Update File: ';
const ADD_FILE_PREFIX = '*** Add File: ';
const DELETE_FILE_PREFIX = '*** Delete File: ';
const MOVE_TO_PREFIX = '*** Move to: ';
const END_OF_FILE_MARKER = '*** End of File';

export interface ApplyPatchOperation {
        readonly type: 'update' | 'add' | 'delete';
        readonly path: string;
        readonly diffLines?: string[];
        readonly movePath?: string;
}

export interface ApplyPatchParsingResult {
        readonly operations: ApplyPatchOperation[];
        readonly annotations: OutcomeAnnotation[];
}

export class PatchEditRules extends PromptElement {
        render() {
                return (
                        <>
                                When proposing a code change, respond with a single `apply_patch` diff that the editor can apply directly.<br />
                                Wrap every response in the following envelope:<br />
                                `*** Begin Patch`<br />
                                &nbsp;&nbsp;&nbsp;&nbsp;`*** Update File: /absolute/path/to/file.ext`<br />
                                &nbsp;&nbsp;&nbsp;&nbsp;One or more diff hunks beginning with `@@` showing context around the change.<br />
                                `*** End Patch`<br />
                                <br />
                                Within each hunk:<br />
                                - Prefix unchanged context lines with a single space.<br />
                                - Prefix removed lines with `-` and added lines with `+`.<br />
                                - Provide at least three lines of context above and below the edited region when possible so the change is uniquely identifiable.<br />
                                - Do not truncate context with `...` and do not wrap the diff in Markdown code fences.<br />
                                - Use absolute file paths that match the user's workspace exactly. Do not attempt to edit more than one file in a single patch.<br />
                        </>
                );
        }
}

export interface PatchEditInputCodeBlockProps extends BasePromptElementProps {
        readonly uri: Uri;
        readonly languageId?: string;
        readonly code: string[] | string;
        readonly isSummarized?: boolean;
        readonly shouldTrim?: boolean;
}

export class PatchEditInputCodeBlock extends PromptElement<PatchEditInputCodeBlockProps> {
        constructor(
                props: PatchEditInputCodeBlockProps,
                @IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
        ) {
                super(props);
        }

        render() {
                const code = typeof this.props.code === 'string' ? this.props.code : this.props.code.join('\n');
                return <>
                        {this.promptPathRepresentationService.getFilePath(this.props.uri)}<br />
                        <CodeBlock code={code} uri={this.props.uri} languageId={this.props.languageId} includeFilepath={false} shouldTrim={this.props.shouldTrim} />
                </>;
        }
}

export interface PatchEditExamplePatchProps extends BasePromptElementProps {
        readonly changes: { uri: URI; find: Lines; replace: Lines }[];
}

export class PatchEditExamplePatch extends PromptElement<PatchEditExamplePatchProps> {
        constructor(
                props: PatchEditExamplePatchProps,
                @IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
        ) {
                super(props);
        }

        render() {
                const examplePath = this.promptPathRepresentationService.getFilePath(this.props.changes[0]?.uri ?? Uri.file('/example.ts'));
                const originalLine = this.props.changes[0]?.find[0] ?? 'oldLine();';
                const newLine = this.props.changes[0]?.replace[0] ?? 'newLine();';
                return <>
                        *** Begin Patch<br />
                        *** Update File: {examplePath}<br />
                        @@<br />
                        -{originalLine}<br />
                        +{newLine}<br />
                        *** End Patch
                </>;
        }
}

export type Patch = { filePath: string; find: Lines; replace: Lines };
export type Section = { marker?: string; content: string[] };

export interface PatchEditReplyProcessor {
        getFirstParagraph(text: string): string;
        process(replyText: string, documentText: string, documentUri?: URI, defaultInsertionLine?: number): PatchEditReplyProcessorResult;
}

export type PatchEditReplyProcessorResult = {
        readonly edits: TextEdit[];
        readonly otherSections: Section[];
        readonly appliedPatches: Patch[];
        readonly otherPatches: Patch[];
        readonly invalidPatches: Patch[];
        readonly contentBefore: Lines;
        readonly contentAfter: Lines;
        readonly annotations: OutcomeAnnotation[];
};

export function sanitizeDiffLines(lines: readonly string[]): string[] {
        return lines.filter(line => line.startsWith('@@') || line.startsWith('+') || line.startsWith('-') || line.startsWith(' '));
}

function linesEditsToTextEdits(edits: LinesEdit[]): TextEdit[] {
        return edits.map(edit => edit.toTextEdit());
}

function parseApplyPatchOperationsFromText(text: string): ApplyPatchParsingResult {
        const operations: ApplyPatchOperation[] = [];
        const annotations: OutcomeAnnotation[] = [];
        let inPatch = false;
        let currentOperation: ApplyPatchOperation | undefined;

        const flush = () => {
                currentOperation = undefined;
        };

        for (const rawLine of text.split(/\r?\n/)) {
                const line = rawLine;
                if (!inPatch) {
                        if (line.startsWith(APPLY_PATCH_BEGIN)) {
                                inPatch = true;
                        }
                        continue;
                }

                if (line.startsWith(APPLY_PATCH_END)) {
                        flush();
                        inPatch = false;
                        continue;
                }

                if (line.startsWith(UPDATE_FILE_PREFIX)) {
                        flush();
                        currentOperation = { type: 'update', path: line.slice(UPDATE_FILE_PREFIX.length).trim(), diffLines: [] };
                        operations.push(currentOperation);
                        continue;
                }

                if (line.startsWith(ADD_FILE_PREFIX)) {
                        flush();
                        operations.push({ type: 'add', path: line.slice(ADD_FILE_PREFIX.length).trim() });
                        continue;
                }

                if (line.startsWith(DELETE_FILE_PREFIX)) {
                        flush();
                        operations.push({ type: 'delete', path: line.slice(DELETE_FILE_PREFIX.length).trim() });
                        continue;
                }

                if (line.startsWith(MOVE_TO_PREFIX)) {
                        if (currentOperation?.type === 'update') {
                                currentOperation.movePath = line.slice(MOVE_TO_PREFIX.length).trim();
                        } else {
                                annotations.push({
                                        message: 'Encountered move directive without an active update',
                                        label: OutcomeAnnotationLabel.INVALID_PATCH,
                                        severity: 'warning'
                                });
                        }
                        continue;
                }

                if (line.startsWith(END_OF_FILE_MARKER) || line.startsWith('***')) {
                        continue;
                }

                if (currentOperation?.type === 'update') {
                        currentOperation.diffLines!.push(line);
                }
        }

        flush();
        return { operations, annotations };
}

export function parseApplyPatchOperations(text: string): ApplyPatchParsingResult {
        return parseApplyPatchOperationsFromText(text);
}

export function getReferencedFiles(replyText: string): string[] {
        const result = parseApplyPatchOperations(replyText);
        return [...new Set(result.operations.map(op => op.path))];
}

function resolveOperationPath(operationPath: string, promptPathRepresentationService: IPromptPathRepresentationService, predominantScheme?: string): string | undefined {
        const resolved = promptPathRepresentationService.resolveFilePath(operationPath, predominantScheme);
        if (!resolved) {
                        return undefined;
        }
        return promptPathRepresentationService.getFilePath(resolved);
}

export function getPatchEditReplyProcessor(promptPathRepresentationService: IPromptPathRepresentationService): PatchEditReplyProcessor {
        return {
                getFirstParagraph(text: string): string {
                        const result: string[] = [];
                        for (const line of text.split(/\r?\n/)) {
                                if (!line || line.startsWith(APPLY_PATCH_BEGIN)) {
                                        break;
                                }
                                result.push(line);
                        }
                        return result.join('\n');
                },
                process(replyText: string, documentText: string, documentUri?: URI): PatchEditReplyProcessorResult {
                        const { operations, annotations: parseAnnotations } = parseApplyPatchOperations(replyText);
                        const annotations: OutcomeAnnotation[] = [...parseAnnotations];
                        const edits: TextEdit[] = [];

                        const otherSections: Section[] = [];
                        const appliedPatches: Patch[] = [];
                        const invalidPatches: Patch[] = [];
                        const otherPatches: Patch[] = [];

                        const documentLines = Lines.fromString(documentText);
                        const documentFilePath = documentUri ? promptPathRepresentationService.getFilePath(documentUri) : undefined;

                        if (operations.some(op => op.type === 'add' || op.type === 'delete')) {
                                annotations.push({ message: 'apply_patch add/delete operations are not supported in this context', label: OutcomeAnnotationLabel.INVALID_PATCH, severity: 'error' });
                                return { edits, otherSections, appliedPatches, otherPatches, invalidPatches, contentBefore: [], contentAfter: [], annotations };
                        }

                        const updateOperations = operations.filter(op => op.type === 'update');

                        if (!updateOperations.length) {
                                annotations.push({ message: 'No patch sections found', label: OutcomeAnnotationLabel.NO_PATCH, severity: 'error' });
                                return { edits, otherSections, appliedPatches, otherPatches, invalidPatches, contentBefore: [], contentAfter: [], annotations };
                        }

                        if (updateOperations.length > 1) {
                                annotations.push({ message: `Multiple files modified: ${updateOperations.map(op => op.path).join(', ')}`, label: OutcomeAnnotationLabel.MULTI_FILE, severity: 'warning' });
                        }

                        for (const operation of updateOperations) {
                                const resolvedPath = resolveOperationPath(operation.path, promptPathRepresentationService, documentUri?.scheme) ?? operation.path;

                                if (documentFilePath && resolvedPath !== documentFilePath) {
                                        annotations.push({ message: `No patch for input document: ${documentFilePath}, patches for ${updateOperations.map(op => op.path).join(', ')}`, label: OutcomeAnnotationLabel.OTHER_FILE, severity: 'warning' });
                                        otherPatches.push({ filePath: operation.path, find: [], replace: [] });
                                        continue;
                                }

                                if (operation.movePath) {
                                        annotations.push({ message: 'File renames are not supported in this context', label: OutcomeAnnotationLabel.INVALID_PATCH, severity: 'warning' });
                                }

                                const diffLines = sanitizeDiffLines(operation.diffLines ?? []);
                                if (!diffLines.length) {
                                        annotations.push({ message: 'Patch is empty', label: OutcomeAnnotationLabel.INVALID_PATCH, severity: 'error' });
                                        continue;
                                }

                                const reporter: Reporter = {
                                        recovery(originalLine) {
                                                annotations.push({ message: `Recovered diff mismatch near original line ${originalLine}`, label: OutcomeAnnotationLabel.INVALID_PATCH, severity: 'warning' });
                                        },
                                        warning(message) {
                                                annotations.push({ message, label: OutcomeAnnotationLabel.INVALID_PATCH, severity: 'warning' });
                                        }
                                };

                                const lineEdits = createEditsFromRealDiff(documentLines, diffLines, reporter);
                                if (!lineEdits.length) {
                                        annotations.push({ message: 'Patch is a no-op', label: OutcomeAnnotationLabel.INVALID_PATCH_NOOP, severity: 'error' });
                                        continue;
                                }

                                edits.push(...linesEditsToTextEdits(lineEdits));
                        }

                        return { edits, otherSections, appliedPatches, otherPatches, invalidPatches, contentBefore: [], contentAfter: [], annotations };
                }
        };
}
