import { builtinRequest } from './builtin';
export type ProxyMode = 'direct' | 'system' | 'custom';
export type ProxyProtocol = 'http' | 'socks5';
export type ProxyView = { mode: ProxyMode; protocol: ProxyProtocol; host: string; port: number; username: string; passwordConfigured: boolean; bypass: string[] };
export type NetworkSettings = { ai: ProxyView; ssh: ProxyView; systemProxy: string };
export type ProxyUpdate = Omit<ProxyView, 'passwordConfigured'> & { password?: string; clearPassword: boolean };
export const networkApi = {
  read: () => builtinRequest<NetworkSettings>('client/network', 'GET', undefined, {}),
  save: (update: { ai: ProxyUpdate; ssh: ProxyUpdate }) => builtinRequest<NetworkSettings>('client/network', 'POST', update, {}),
};
