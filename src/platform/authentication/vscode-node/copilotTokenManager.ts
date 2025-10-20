/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The legacy token manager exposed a number of error classes that the rest of the
// codebase still imports for control flow. The MyAI integration no longer throws
// these errors, but we keep the definitions to avoid breaking those imports.

export class NotSignedUpError extends Error { }
export class SubscriptionExpiredError extends Error { }
export class ContactSupportError extends Error { }
export class EnterpriseManagedError extends Error { }
export class ChatDisabledError extends Error { }

