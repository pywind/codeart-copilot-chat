/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TelemetryEventProperties, TelemetryProperties } from './telemetry';

export class TelemetryData {
        public properties: TelemetryProperties;
        public measurements: { [key: string]: number | undefined };
        public issuedTime: number;
        public displayedTime: number | undefined;

        private constructor(
                properties: TelemetryProperties,
                measurements: { [key: string]: number | undefined },
                issuedTime: number,
        ) {
                this.properties = properties;
                this.measurements = measurements;
                this.issuedTime = issuedTime;
        }

        static createAndMarkAsIssued(
                properties?: { [key: string]: string },
                measurements?: { [key: string]: number | undefined }
        ): TelemetryData {
                return new TelemetryData({ ...(properties ?? {}) }, { ...(measurements ?? {}) }, Date.now());
        }

        extendedBy(properties?: TelemetryProperties, measurements?: { [key: string]: number | undefined }): TelemetryData {
                const newProperties = { ...this.properties, ...(properties ?? {}) };
                const newMeasurements = { ...this.measurements, ...(measurements ?? {}) };
                const copy = new TelemetryData(newProperties, newMeasurements, this.issuedTime);
                copy.displayedTime = this.displayedTime;
                return copy;
        }

        markAsDisplayed(): void {
                if (this.displayedTime === undefined) {
                        this.displayedTime = Date.now();
                }
        }
}

export function eventPropertiesToSimpleObject(properties?: TelemetryEventProperties): TelemetryProperties | undefined {
        if (!properties) {
                return;
        }
        const simpleObject: TelemetryProperties = {};
        for (const key of Object.keys(properties)) {
                const value = properties[key];
                if (value !== undefined) {
                        simpleObject[key] = value;
                }
        }
        return simpleObject;
}
