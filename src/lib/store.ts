/** Global viewer state (zustand) + localStorage-backed preferences. */
import { create } from 'zustand';
import type { ApiChannel } from './types';

const LS = {
  token: 'sp-token',
  volume: 'sp-vol',
  muted: 'sp-muted',
  group: 'sp-group',
  onlineOnly: 'sp-online',
  last: 'sp-last',
  listHidden: 'sp-list-hidden',
} as const;

export const prefs = {
  get(key: keyof typeof LS): string | null {
    try {
      return localStorage.getItem(LS[key]);
    } catch {
      return null;
    }
  },
  set(key: keyof typeof LS, value: string): void {
    try {
      localStorage.setItem(LS[key], value);
    } catch {
      /* storage unavailable */
    }
  },
};

interface ViewerState {
  channels: ApiChannel[];
  loadingChannels: boolean;
  channelsError: string | null;
  currentId: string | null;
  token: string;
  search: string;
  group: string;
  onlineOnly: boolean;
  listHidden: boolean;
  checkAllActive: boolean;
  checkProgress: { done: number; total: number };
  shareChannelId: string | null;
  tokenDialogOpen: boolean;

  setChannels: (channels: ApiChannel[]) => void;
  setLoading: (loading: boolean) => void;
  setChannelsError: (error: string | null) => void;
  patchChannel: (id: string, patch: Partial<ApiChannel>) => void;
  setCurrent: (id: string | null) => void;
  setToken: (token: string) => void;
  setSearch: (search: string) => void;
  setGroup: (group: string) => void;
  setOnlineOnly: (on: boolean) => void;
  setListHidden: (hidden: boolean) => void;
  setCheckAll: (active: boolean, progress?: { done: number; total: number }) => void;
  openShare: (channelId: string | null) => void;
  setTokenDialogOpen: (open: boolean) => void;
}

export const useViewer = create<ViewerState>((set) => ({
  channels: [],
  loadingChannels: true,
  channelsError: null,
  currentId: null,
  token: '',
  search: '',
  group: '__all',
  onlineOnly: false,
  listHidden: false,
  checkAllActive: false,
  checkProgress: { done: 0, total: 0 },
  shareChannelId: null,
  tokenDialogOpen: false,

  setChannels: (channels) => set({ channels }),
  setLoading: (loadingChannels) => set({ loadingChannels }),
  setChannelsError: (channelsError) => set({ channelsError }),
  patchChannel: (id, patch) =>
    set((s) => ({
      channels: s.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })),
  setCurrent: (currentId) => {
    if (currentId) prefs.set('last', currentId);
    set({ currentId });
  },
  setToken: (token) => {
    if (token) prefs.set('token', token);
    set({ token });
  },
  setSearch: (search) => set({ search }),
  setGroup: (group) => {
    if (group !== '__all') prefs.set('group', group);
    set({ group });
  },
  setOnlineOnly: (onlineOnly) => {
    prefs.set('onlineOnly', onlineOnly ? '1' : '0');
    set({ onlineOnly });
  },
  setListHidden: (listHidden) => {
    prefs.set('listHidden', listHidden ? '1' : '0');
    set({ listHidden });
  },
  setCheckAll: (checkAllActive, progress) =>
    set((s) => ({
      checkAllActive,
      checkProgress: progress ?? (checkAllActive ? s.checkProgress : { done: 0, total: 0 }),
    })),
  openShare: (shareChannelId) => set({ shareChannelId }),
  setTokenDialogOpen: (tokenDialogOpen) => set({ tokenDialogOpen }),
}));

/** Client-side filter used by the list and by prev/next channel stepping. */
export function visibleChannels(s: {
  channels: ApiChannel[];
  search: string;
  group: string;
  onlineOnly: boolean;
}): ApiChannel[] {
  const q = s.search.trim().toLowerCase();
  return s.channels.filter((c) => {
    if (s.group && s.group !== '__all' && c.group !== s.group) return false;
    if (s.onlineOnly && c.status !== 'online') return false;
    if (!q) return true;
    return `${c.name} ${c.id} ${c.tvgId ?? ''}`.toLowerCase().includes(q);
  });
}
