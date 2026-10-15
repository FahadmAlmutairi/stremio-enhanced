import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../constants';
import { type ExternalPlayer } from '../../interfaces/ExternalPlayerTypes';

type PlayerPaths = { vlc: string | null; mpv: string | null };

// Used by the preload only. This is intentionally not exposed to the page through contextBridge,
// since it starts programs on the user's machine.
export const externalPlayerAPI = {
    launchExternalPlayer: (player: ExternalPlayer, streamUrl: string): Promise<{ success: boolean; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.LAUNCH_EXTERNAL_PLAYER, player, streamUrl);
    },
    getExternalPlayerPaths: (): Promise<PlayerPaths & { custom: PlayerPaths }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_EXTERNAL_PLAYER_PATHS);
    },
    setExternalPlayerPath: (player: ExternalPlayer, path: string): Promise<{ success: boolean; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SET_EXTERNAL_PLAYER_PATH, player, path);
    },
};
