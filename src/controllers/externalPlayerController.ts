import * as net from 'net';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { execFile } from 'child_process';
import { getLogger } from '../utils/logger';
import { IPC_CHANNELS } from '../constants';
import { app, dialog, ipcMain, BrowserWindow } from 'electron';
import { VALID_EXTERNAL_PLAYERS, type ExternalPlayer } from '../interfaces/ExternalPlayerTypes';

const logger = getLogger("ExternalPlayerController");

// Common socket paths per platform
const MPV_SOCKET = process.platform === 'win32' ? '\\\\.\\pipe\\mpvsocket' : '/tmp/mpvsocket';
const VLC_HTTP_PORT = 9090;
const VLC_HTTP_PASSWORD = 'stremio';

// Common install paths per platform
const PLAYER_PATHS: Record<string, Record<string, string[]>> = {
    win32: {
        vlc: ['C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'],
        mpv: ['C:\\Program Files\\mpv\\mpv.exe', 'C:\\Program Files (x86)\\mpv\\mpv.exe'],
    },
    darwin: {
        vlc: ['/Applications/VLC.app/Contents/MacOS/VLC'],
        mpv: ['/usr/local/bin/mpv', '/opt/homebrew/bin/mpv'],
    },
    linux: {
        vlc: ['/usr/bin/vlc'],
        mpv: ['/usr/bin/mpv'],
    },
};

type PlayerName = 'vlc' | 'mpv';

let pollInterval: ReturnType<typeof setInterval> | null = null;
let activeChild: ReturnType<typeof execFile> | null = null;

// Custom player paths are stored by the main process instead of the page's localStorage,
// so scripts running in the page (plugins, web.stremio.com) can't choose which program gets executed.
const getCustomPathsFile = () => join(app.getPath('userData'), 'external_player_paths.json');

function isPlayerName(player: unknown): player is PlayerName {
    return player === 'vlc' || player === 'mpv';
}

function isExistingFile(path: unknown): path is string {
    if (typeof path !== 'string' || !isAbsolute(path)) return false;
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function readCustomPaths(): Partial<Record<PlayerName, string>> {
    try {
        const data = JSON.parse(readFileSync(getCustomPathsFile(), 'utf-8'));
        const paths: Partial<Record<PlayerName, string>> = {};
        if (isExistingFile(data?.vlc)) paths.vlc = data.vlc;
        if (isExistingFile(data?.mpv)) paths.mpv = data.mpv;
        return paths;
    } catch {
        return {};
    }
}

function writeCustomPaths(paths: Partial<Record<PlayerName, string>>): void {
    writeFileSync(getCustomPathsFile(), JSON.stringify(paths, null, 2));
}

function findPlayerPath(player: PlayerName): string | null {
    const paths = PLAYER_PATHS[process.platform]?.[player] ?? [];
    return paths.find(p => existsSync(p)) ?? null;
}

// Only http(s) URLs are passed to the player. This also guarantees the
// argument can't start with "-" and be parsed as a player option.
function isValidStreamUrl(streamUrl: unknown): streamUrl is string {
    if (typeof streamUrl !== 'string') return false;
    try {
        const { protocol } = new URL(streamUrl);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

async function getMpvStatus(): Promise<{ position: number; state: 'playing' | 'paused' } | null> {
    return new Promise((resolve) => {
        const socket = net.createConnection(MPV_SOCKET);
        const requests = [
            JSON.stringify({ command: ['get_property', 'time-pos'], request_id: 1 }),
            JSON.stringify({ command: ['get_property', 'pause'], request_id: 2 }),
        ];
        let resolved = false;
        let position: number | null = null;
        let paused: boolean | null = null;
        let buffer = '';

        const done = (val: { position: number; state: 'playing' | 'paused' } | null) => {
            if (!resolved) { resolved = true; resolve(val); socket.destroy(); }
        };

        const tryResolve = () => {
            if (position !== null && paused !== null)
                done({ position, state: paused ? 'paused' : 'playing' });
        };

        socket.on('connect', () => requests.forEach(r => socket.write(r + '\n')));
        socket.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const res = JSON.parse(line);
                    if (res.request_id === 1) position = res.data ?? null;
                    if (res.request_id === 2) paused = res.data ?? null;
                    tryResolve();
                } catch { /* ignore */ }
            }
        });
        socket.on('error', () => done(null));
        setTimeout(() => done(null), 1000);
    });
}

async function getVlcStatus(): Promise<{ position: number; state: 'playing' | 'paused' | 'stopped' } | null> {
    try {
        const auth = Buffer.from(`:${VLC_HTTP_PASSWORD}`).toString('base64');
        const res = await fetch(`http://localhost:${VLC_HTTP_PORT}/requests/status.json`, {
            headers: { Authorization: `Basic ${auth}` }
        });
        if (!res.ok) return null;
        const data = await res.json() as any;
        if (data.time == null || data.state == null) return null;
        return { position: data.time, state: data.state };
    } catch {
        return null;
    }
}

function startPolling(player: ExternalPlayer, child: ReturnType<typeof execFile>) {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
        if (activeChild !== child) {
            clearInterval(pollInterval!);
            pollInterval = null;
            return;
        }

        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;

        const status = player === 'mpv'
            ? await getMpvStatus()
            : await getVlcStatus();

        if (!status) return; // player not ready yet or temporarily unavailable, keep polling

        win.webContents.send(IPC_CHANNELS.EXTERNAL_PLAYER_POSITION, status);
    }, 5000);
}

export const externalPlayerController = {
    initIPC: () => {
        ipcMain.handle(IPC_CHANNELS.LAUNCH_EXTERNAL_PLAYER, (_, player: string, streamUrl: string) => {
            if (!VALID_EXTERNAL_PLAYERS.includes(player as ExternalPlayer) || !isPlayerName(player)) {
                logger.error(`Invalid external player: ${player}`);
                return { success: false, error: `Invalid player: ${player}` };
            }

            if (!isValidStreamUrl(streamUrl)) {
                logger.error(`Refusing to launch ${player} with an invalid stream URL: ${streamUrl}`);
                return { success: false, error: 'Invalid stream URL.' };
            }

            const playerPath = readCustomPaths()[player] || findPlayerPath(player);
            if (!playerPath) {
                logger.error(`${player} not found at any known path.`);
                return { success: false, error: `${player} not found. Please install it or set a custom path in settings.` };
            }

            // kill previous player if still running
            if (activeChild) {
                activeChild.kill();
            }
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }

            const args = player === 'mpv'
                ? [streamUrl, `--input-ipc-server=${MPV_SOCKET}`]
                : [streamUrl, '--extraintf=http', `--http-password=${VLC_HTTP_PASSWORD}`, `--http-port=${VLC_HTTP_PORT}`];

            logger.info(`Launching ${player} at ${playerPath} with URL: ${streamUrl}`);

            const child = execFile(playerPath, args, (err) => {
                if (err) logger.error(`Failed to launch ${player}: ${err.message}`);
            });

            activeChild = child;

            child.on('exit', () => {
                // only handle exit if this is still the active child
                if (activeChild !== child) return;
                activeChild = null;
                if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
                const win = BrowserWindow.getAllWindows()[0];
                if (win) win.webContents.send(IPC_CHANNELS.EXTERNAL_PLAYER_CLOSED);
            });

            setTimeout(() => startPolling(player as ExternalPlayer, child), 2000);

            return { success: true };
        });

        ipcMain.handle(IPC_CHANNELS.GET_EXTERNAL_PLAYER_PATHS, () => {
            const custom = readCustomPaths();
            return {
                vlc: findPlayerPath('vlc'),
                mpv: findPlayerPath('mpv'),
                custom: { vlc: custom.vlc ?? null, mpv: custom.mpv ?? null },
            };
        });

        // Setting a custom path always requires the user to confirm it in a native dialog,
        // so a script in the page can't silently point the player at another program.
        ipcMain.handle(IPC_CHANNELS.SET_EXTERNAL_PLAYER_PATH, async (event, player: unknown, path: unknown) => {
            if (!isPlayerName(player)) return { success: false, error: 'Invalid player.' };

            const paths = readCustomPaths();
            const newPath = typeof path === 'string' ? path.trim() : '';

            if (!newPath) {
                delete paths[player];
                writeCustomPaths(paths);
                logger.info(`Custom ${player} path cleared, using auto-detect`);
                return { success: true };
            }

            if (!isExistingFile(newPath)) {
                return { success: false, error: 'The path must be the full path to an existing file.' };
            }

            if (paths[player] === newPath) return { success: true };

            const options = {
                type: 'warning' as const,
                buttons: ['Allow', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                title: 'Confirm external player',
                message: `Use this program as ${player.toUpperCase()}?`,
                detail: `${newPath}\n\nStremio Enhanced will run this program every time a stream is opened in ${player.toUpperCase()}. Only allow this if you entered this path yourself.`,
            };
            const win = BrowserWindow.fromWebContents(event.sender);
            const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);

            if (response !== 0) {
                logger.warn(`User did not confirm custom ${player} path: ${newPath}`);
                return { success: false, error: 'Custom path was not confirmed.' };
            }

            paths[player] = newPath;
            writeCustomPaths(paths);
            logger.info(`Custom ${player} path set to: ${newPath}`);
            return { success: true };
        });
    }
};
