/* eslint-disable no-console */
import {UploadStream}                                      from '@state/models/UploadStream';
import {uid}                                               from '@utils/uid';
import GracefulWebSocket                                   from 'graceful-ws';
import {action, observable}                                from 'mobx';
import {Upload}                                            from '../models/Upload';
import {files, Keys}                                       from './Files';
import {pushNotification}                                  from './Notify';
import {resetRemoteSettings, settings, syncRemoteSettings} from './Settings';
import {uploads}                                           from './Uploads';

export type ConnectionState = 'connected' | 'disconnected';

type RequestResolver = [
    (resolve: unknown) => void,
    (reason: unknown) => void
];

class Socket {
    @observable public connectionState: ConnectionState;
    private readonly requests: Map<string, RequestResolver>;
    private readonly ws: GracefulWebSocket;
    private connectionLost = false;
    private messageQueue: Array<unknown>;
    private sessionKey: string | null;

    constructor() {
        this.ws = new GracefulWebSocket(env.WS_ENDPOINT);
        this.connectionState = 'disconnected';
        this.messageQueue = [];
        this.requests = new Map();
        this.sessionKey = null;

        this.ws.addEventListener('connected', () => {
            console.log('[WS] Connected!');

            if (settings.notifications.onConnectionChange && this.connectionLost) {
                this.connectionLost = false;

                // Show notification if enabled
                pushNotification({
                    title: 'Connected again 😋',
                    body: 'Share something!'
                });
            }

            // Try to re-establish connection or create a new session
            if (this.sessionKey !== null) {
                console.log('[WS] Try to restore session.');
                this.sendMessage('restore-session', this.sessionKey);
            } else {
                console.log('[WS] Request new session.');
                this.sendMessage('create-session');
            }
        });

        this.ws.addEventListener('disconnected', () => {
            this.updateState('disconnected');
            this.connectionLost = true;
            console.log('[WS] Disconnected!');

            // Show notification if enabled
            if (settings.notifications.onConnectionChange) {
                pushNotification({
                    title: 'Connection lost... 😢',
                    body: 'Tell your friends to wait a second, we\'re working on it!'
                });
            }

            // Pause all uploads and mark all files as pending
            uploads.massAction('pause');
            files.resetFiles();
        });

        this.ws.addEventListener('message', (e: unknown) => {
            try {
                const {type, payload} = JSON.parse((e as MessageEvent).data);
                this.onMessage(type, payload);
            } catch (e) {
                console.error(e);
            }
        });
    }

    public sendMessage(type: string, payload: unknown = null): void {
        const message = {type, payload};

        if (this.ws.connected) {
            this.ws.send(JSON.stringify(message));
        } else {
            this.messageQueue.push(message);
        }
    }

    public request(type: string, data: unknown = null): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            const id = uid('wsr');

            this.sendMessage('request', {
                id, type, data
            });

            this.requests.set(id, [resolve, reject]);
        });
    }

    @action
    private flushMessageQueue() {
        if (!this.ws.connected) {
            throw new Error('Cannot clear message queue if not connected.');
        }

        this.ws.send(JSON.stringify({
            type: 'bulk',
            payload: this.messageQueue
        }));

        this.messageQueue = [];
    }

    @action
    private updateState(newState: ConnectionState) {
        this.connectionState = newState;
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    private onMessage(type: string, payload: any): void {
        switch (type) {
            case 'response': {
                const {id, ok, data} = payload;
                const resolvers = this.requests.get(id);

                if (!resolvers) {
                    console.warn(`[WS] Unknown response for id ${id}`);
                    break;
                }

                if (ok) {
                    resolvers[0](data);
                } else {
                    resolvers[1](data);
                }

                break;
            }
            case 'restore-session': {
                console.log('[WS] Session restored.');

                // Restore settings and files
                resetRemoteSettings(payload.settings);
                files.activate(payload.files);

                // Send pending messages
                this.flushMessageQueue();

                // Update state and session-key
                this.updateState('connected');
                this.sessionKey = payload.key;
                break;
            }
            case 'new-session': {
                console.log('[WS] New session started.');

                // We're now "officially" connected
                this.updateState('connected');
                this.sessionKey = payload;

                // Refresh keys, cancel all uploads and sync settings with server
                files.refresh(...files.listedFiles);
                syncRemoteSettings();
                uploads.massStatusUpdate('connection-lost');
                this.flushMessageQueue();
                break;
            }
            case 'file-registrations': {
                files.activate(payload as Keys);
                break;
            }
            case 'file-request': {
                const {fileId, downloadId} = payload;

                const item = files.listedFiles.find(
                    value => value.id === fileId
                );

                if (!item) {
                    console.warn('[WS] File not longer available...');
                    break;
                }

                const upload = new Upload({
                    listedFile: item,
                    id: downloadId,
                    url: `${env.API_ENDPOINT}/file/${downloadId}`
                });

                uploads.registerUpload(upload);
                break;
            }
            case 'stream-request': {
                const {fileId, streamId, streamKey, range} = payload;

                const item = files.listedFiles.find(
                    value => value.id === fileId
                );

                if (!item) {
                    console.warn('[WS] File not longer available...');
                    break;
                }

                const stream = uploads.listedUploads.find(value => {
                    return value instanceof UploadStream && value.streamKey === streamKey;
                });

                if (stream && range !== undefined) {
                    (stream as UploadStream).consume(range, `${env.API_ENDPOINT}/stream/${streamId}`, streamId);
                } else {
                    const upload = new UploadStream(streamKey, item);
                    upload.consume(range, `${env.API_ENDPOINT}/stream/${streamId}`, streamId);
                    uploads.registerUpload(upload);
                }

                break;
            }
            case 'stream-cancelled': {
                uploads.cancelStream(payload);
                break;
            }
            case 'download-cancelled': {
                const target = uploads.listedUploads.find(v => v.id === payload);

                if (target) {
                    uploads.performMassStatusUpdate([target], 'peer-cancelled');
                }

                break;
            }
            default: {
                console.warn(`[WS] Unknown action: ${type}`);
            }
        }
    }
}

export const socket = new Socket();
