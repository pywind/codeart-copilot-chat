/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { IDisposable } from '../../../util/vs/base/common/lifecycle';

export type TelemetryEventMeasurements = Record<string, number | undefined>;
export type TelemetryEventProperties = Record<string, string | undefined>;
export type TelemetryProperties = Record<string, string>;
export type AdditionalTelemetryProperties = Record<string, string>;

export type TelemetryDestination = {
        github: boolean | { eventNamePrefix: string };
        microsoft: boolean;
};

export interface ITelemetryEvent {
        eventName: string;
        properties?: object;
        measurements?: object;
}

export interface ITelemetryUserConfig {
        readonly _serviceBrand: undefined;
        trackingId: string | undefined;
        organizationsList: string | undefined;
        optedIn: boolean;
}

export const ITelemetryUserConfig = createServiceIdentifier<ITelemetryUserConfig>('ITelemetryUserConfig');

export class TelemetryUserConfigImpl implements ITelemetryUserConfig {
        declare readonly _serviceBrand: undefined;
        public organizationsList: string | undefined;

        constructor(
                public trackingId: string | undefined,
                public optedIn: boolean | undefined,
        ) {
                this.trackingId = trackingId;
                this.organizationsList = undefined;
                this.optedIn = optedIn ?? false;
        }
}

export interface ITelemetryService extends IDisposable {
        readonly _serviceBrand: undefined;

        setSharedProperty(name: string, value: string): void;
        postEvent(eventName: string, props: Map<string, string>): void;

        sendInternalMSFTTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;
        sendMSFTTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;
        sendMSFTTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;

        sendGHTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;
        sendGHTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;
        sendGHTelemetryException(maybeError: unknown, origin: string): void;

        sendEnhancedGHTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;
        sendEnhancedGHTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;

        sendTelemetryEvent(eventName: string, destination: TelemetryDestination, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;
        sendTelemetryEvent<TTelemetryEvent extends ITelemetryEvent>(eventName: TTelemetryEvent['eventName'], destination: TelemetryDestination, properties?: TTelemetryEvent['properties'], measurements?: TTelemetryEvent['measurements']): void;
        sendTelemetryErrorEvent(eventName: string, destination: TelemetryDestination, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;

        setAdditionalExpAssignments(expAssignments: string[]): void;
}

export const ITelemetryService = createServiceIdentifier<ITelemetryService>('ITelemetryService');

export function multiplexProperties(properties: { [key: string]: string | undefined }): { [key: string]: string | undefined } {
        return { ...properties };
}
