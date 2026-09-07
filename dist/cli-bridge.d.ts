export declare function cliCommand(platform?: string, env?: NodeJS.ProcessEnv): Promise<{
    command: string;
    prefix: string[];
}>;
export declare function cliJson(args: string[], timeout?: number): Promise<Record<string, any>>;
