import { Opts, ProfileOpts, ThreadOpts, FilterOpts } from './types';
declare function init(sbot: any, _config: any): {
    public: (opts: Opts) => any;
    publicUpdates: (opts: FilterOpts) => any;
    profile: (opts: ProfileOpts) => any;
    thread: (opts: ThreadOpts) => any;
};
declare const _default: {
    name: string;
    version: string;
    manifest: {
        public: string;
        publicUpdates: string;
        profile: string;
        thread: string;
    };
    permissions: {
        master: {
            allow: string[];
        };
    };
    init: typeof init;
};
export = _default;
