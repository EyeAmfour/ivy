/*
 * Copyright (c) 2021 ILEFA Labs
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import { Logger } from './logger';
import { spawn } from 'child_process';
import { StartupRunnable } from './startup';
import { GuildDataProvider, GuildTokenLike } from './data';

import {
    Client,
    ClientOptions,
    ColorResolvable,
    Guild,
    PresenceData,
    User
} from 'discord.js';

import {
    Command,
    CommandManager,
    DefaultEventManager,
    EventManager,
    GenericTestCommand,
    Module,
    ModuleManager,
    TestCommand
} from './module';

export type IvyEngineOptions = {
    token: string;
    name: string;
    logger: Logger;
    gitRepo?: string;
    superPerms: string[];
    reportErrors: string[];
    color: ColorResolvable;
    provider: GuildDataProvider<GuildTokenLike>;
    startup?: StartupRunnable;
    eventHandler?: EventManager;
    presence?: PresenceData;
    discord?: ClientOptions;
}

export enum IvyEmbedIcons {
    AUDIO = 'https://storage.googleapis.com/stonks-cdn/audio.png',
    BIRTHDAY = 'https://storage.googleapis.com/stonks-cdn/birthday.png',
    EDU = 'https://storage.googleapis.com/stonks-cdn/univ.png',
    ERROR = 'https://storage.googleapis.com/stonks-cdn/error.png',
    HELP = 'https://storage.googleapis.com/stonks-cdn/help.png',
    MEMBER = 'https://storage.googleapis.com/stonks-cdn/jack.png',
    MESSAGE = 'https://storage.googleapis.com/stonks-cdn/message.png',
    NUMBERS = 'https://storage.googleapis.com/stonks-cdn/counther.png',
    POLL = 'https://storage.googleapis.com/stonks-cdn/poll.png',
    PREFS = 'https://storage.googleapis.com/stonks-cdn/prefs.png',
    STONKS = 'https://storage.googleapis.com/stonks-cdn/stonks.png',
    TEST = 'https://storage.googleapis.com/stonks-cdn/test.png',
    XP = 'https://storage.googleapis.com/stonks-cdn/xp.png'
}

export abstract class IvyEngine {

    start: number;
    client: Client;
    logger: Logger;
    icons: IvyEmbedIcons;
    opts: IvyEngineOptions;
    moduleManager: ModuleManager;
    commandManager: CommandManager;
    provider: GuildDataProvider<GuildTokenLike>;

    private HASH_PATTERN = /\b[0-9a-f]{5,40}\b/;
    private GIT_REPO_PATTERN = /\w+\/\w+/;
    private vcsEnabled: boolean;

    constructor(opts: IvyEngineOptions) {
        this.start = Date.now();
        this.opts = opts;
        this.logger = opts.logger;
        this.vcsEnabled = !!opts.gitRepo;
        if (this.vcsEnabled && !this.GIT_REPO_PATTERN.test(this.opts.gitRepo)) {
            this.vcsEnabled = false;
        }

        this.client = new Client(opts.discord || {
            partials: ['CHANNEL', 'MESSAGE', 'REACTION'],
            fetchAllMembers: true
        });

        this.moduleManager = new ModuleManager(this);
        this.commandManager = new CommandManager(this);

        this.moduleManager.registerModule(opts.eventHandler || new DefaultEventManager(this));

        this.registerCommands();
        this.registerFlows();
        this.registerModules();

        this.opts.startup?.run(this);
        this.moduleManager.init();

        this.client.login(opts.token);
        this.client.on('ready', async () => {
            if (this.vcsEnabled) {
                this.logger.info(opts.name, `Release channel: ${await this.getReleaseChannel()}, version: ${await this.getCurrentVersion()}`);
            }

            this.logger.info(opts.name, 'Successfully connected to Discord.');
            this.client.user.setPresence(opts.presence || {
                status: 'online',
                activity: {
                    type: 'PLAYING',
                    name: 'with the ivy platform.'
                }
            });

            this.onReady(this.client);
        });
    }

    abstract registerCommands(): void;
    abstract registerModules(): void;
    abstract registerFlows(): void;
    abstract onReady(client: Client): void;

    /**
     * Registers a command.
     * 
     * @param name the name of the command
     * @param command the command instance
     */
    registerCommand = (name: string, command: Command) => this.commandManager.registerCommand(name, command);

    /**
     * Registers a module.
     * @param module the module instance
     */
    registerModule = (module: Module) => this.moduleManager.registerModule(module);

    /**
     * Registers a flow.
     * @param flow the flow to register
     */
    registerFlow = (flow: TestCommand) => this.commandManager.registerTestFlow(flow);

    /**
     * Registers a managed flow.
     * 
     * @param flow the managed flow to register
     * @param module the manager for this flow
     */
    registerManagedFlow = <T extends Module>(flow: GenericTestCommand<T>, module: T) => this.commandManager.registerGenericTestFlow(flow, module);

    /**
     * Returns whether or not a given user has
     * a certain bot permission in a given guild.
     * 
     * Note: This does not necessarily mean that
     * the user has that permission in the guild
     * (in the case of superperms users always being true).
     * 
     * @param user the user in question
     * @param permission the permission in question
     * @param guild the guild in which this takes place
     */
    has = (user: User, permission: number, guild: Guild) => {
        return guild
            .member(user)
            .hasPermission(permission) 
                || this
                    .opts
                    .superPerms
                    .some(id => user.id === id)
    }

    /**
     * Spawns a shell and runs git command.
     * @param args args to pass to <git ...>
     */
    private execGit = (args: string): Promise<string> => new Promise((res, rej) => {
        const srv = spawn('git', args.split(' '));
        const out = {
            stdout: [],
            stderr: []
        }

        srv.stdout.on('data', data => out.stdout.push(data.toString()));
        srv.stderr.on('data', data => out.stderr.push(data.toString()));
        srv.on('exit', code => {
            if (code !== 0) {
                return rej(out.stderr.join('').trim());
            }

            res(out
                .stdout
                .join('')
                .trim());
        })
    });

    /**
     * Returns the current git version of this project.
     */
    getCurrentVersion = async () => {
        if (!this.vcsEnabled) {
            return 'unknown';
        }

        let res = await this.execGit('rev-parse HEAD').catch(err => null);
        if (!this.HASH_PATTERN.test(res)) {
            return 'unknown';
        }

        return res.substring(0, 7);
    };

    /**
     * Returns the current upstream git version of this project.
     */
    getUpstreamVersion = async () => {
        if (!this.vcsEnabled) {
            return 'unknown';
        }

        let res = await this.execGit(`ls-remote git@github.com:${this.opts.gitRepo}.git | grep refs/heads/${await this.getReleaseChannel()} | cut -f 1`).catch(err => null);
        if (!res) {
            return 'unknown';   
        }

        return res.substr(0, 7);
    }

    /**
     * Returns the current "release channel" aka branch of this local build.
     */
    getReleaseChannel = async () => {
        if (!this.vcsEnabled) {
            return 'unknown';
        }

        let res = await this.execGit('rev-parse --abbrev-ref HEAD').catch(err => null);
        if (!res || res.startsWith('fatal')) {
            return 'unknown';
        }

        return res;
    };

    /**
     * Attempts to pull the latest version of this project from the git repository.
     * @param then what to do with the new version, or "Failure" if it doesn't succeed.
     */
    update = async (then?: (version: String) => void) => {
        if (!this.vcsEnabled) {
            return then('Failure');
        }

        let local = await this.getCurrentVersion();
        let remote = await this.getUpstreamVersion();
        if (local.toLowerCase() === remote.toLowerCase()) {
            return then(local);
        }

        let res = await this.execGit('git pull');
        if (!res) {
            return then('Failure');
        }

        return then(await this.getCurrentVersion());
    }

}