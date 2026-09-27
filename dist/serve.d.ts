import http from "node:http";
import { type HostedApp } from "./hosted/app.js";
/**
 * Support secret mounts: for NAME_FILE=/run/secrets/x, set NAME from the file contents
 * unless NAME is already set. Limited to credential and store-config variables.
 */
export declare function loadFileSecrets(env?: NodeJS.ProcessEnv): void;
export interface ServeConfig {
    publicUrl: string;
    host: string;
    port: number;
}
export declare function buildHostedAppFromEnv(env?: NodeJS.ProcessEnv): Promise<{
    app: HostedApp;
    config: ServeConfig;
}>;
export declare function serve(env?: NodeJS.ProcessEnv): Promise<http.Server>;
