import { Msg, MsgId } from 'ssb-typescript';
export declare type Thread = {
    messages: Array<Msg>;
    full: boolean;
};
export declare type FilterOpts = {
    allowlist?: Array<string>;
    blocklist?: Array<string>;
};
export declare type Opts = {
    lt?: number;
    limit?: number;
    live?: boolean;
    reverse?: boolean;
    threadMaxSize?: number;
} & FilterOpts;
export declare type UpdatesOpts = {} & FilterOpts;
export declare type ThreadOpts = {
    root: MsgId;
    threadMaxSize?: number;
} & FilterOpts;
export declare type ProfileOpts = Opts & {
    id: string;
};
