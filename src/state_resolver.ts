interface MatrixEvent {
    event_id: string;
    type: string;
    state_key?: string;
    // biome-ignore lint/suspicious/noExplicitAny: we don't know the values.
    content: Record<string, any>;
    sender: string;
    depth: number;
    prev_events: Array<string>;
    auth_events: Array<string>;
    room_id: string;

    // TODO: fix metadata fields
    _collapse?: number;
    _backwards_extremity_key?: string;
}

enum MsgType {
    GetEvent = "get_event",
    ResolveState = "resolve_state",
}

interface WebSocketMessage<T> {
    type: MsgType;
    id: string;
    error?: string;
    data: T;
}

type StateKeyTuple = string; // JSON encoded array of 2 string elements [type, state_key]
export type EventID = string;

interface DataResolveState {
    room_id: string;
    room_version: string;
    state: Array<Record<StateKeyTuple, EventID>>;
    result?: Record<StateKeyTuple, EventID>;
}
interface DataGetEvent {
    event_id: string;
    event: MatrixEvent;
}

interface StateResolverReceiver {
    onGetEventRequest(data: DataGetEvent): MatrixEvent;
    onResolveStateResponse(id: string, data: DataResolveState);
}

interface StateResolverSender {
    sendResolveState(id: string, data: DataResolveState);
}

interface ResolvedState {
    eventIds: Array<string>;
}

class StateResolver implements StateResolverReceiver {
    inflightRequests: Map<string, (DataResolveState) => void>;
    constructor(
        readonly sender: StateResolverSender,
        readonly getEvent: (data: DataGetEvent) => MatrixEvent,
    ) {
        this.inflightRequests = new Map();
    }

    onGetEventRequest(data: DataGetEvent): MatrixEvent {
        return this.getEvent(data);
    }

    onResolveStateResponse(id: string, data: DataResolveState) {
        const resolve = this.inflightRequests.get(id);
        if (!resolve) {
            console.error(`onResolveStateResponse: no request id for response! id=${id}`);
            return;
        }
        resolve(data);
        this.inflightRequests.delete(id);
    }

    async resolveState(roomVersion: string, stateEvents: Array<MatrixEvent>): Promise<ResolvedState> {
        // convert events into a form suitable for sending over the wire
        const state: Array<Record<StateKeyTuple, EventID>> = [];
        const initialSetOfEventIds = new Set<string>();
        let roomId = "";
        for (const ev of stateEvents) {
            state.push({
                [`${JSON.stringify([ev.type, ev.state_key])}`]: ev.event_id,
            });
            initialSetOfEventIds.add(ev.event_id);
            roomId = ev.room_id;
        }
        console.log("resolveState", state);
        // make an id so we can pair it up when we get the response
        const id = globalThis.crypto.randomUUID();
        const promise = new Promise<ResolvedState>((resolve, reject) => {
            this.inflightRequests.set(id, (resolvedData: DataResolveState) => {
                if (!resolvedData.result) {
                    resolve({
                        eventIds: [],
                    });
                    return;
                }
                resolve({
                    eventIds: Array.from(Object.values(resolvedData.result)),
                });
            });
            this.sender.sendResolveState(id, {
                state: state,
                room_id: roomId,
                room_version: roomVersion,
            });
        });

        return promise;
    }
}

class StateResolverTransport implements StateResolverSender {
    ws: WebSocket;
    receiver: StateResolverReceiver;

    constructor(readonly url: string) {}

    async sendResolveState(id: string, data: DataResolveState) {
        this.sendWs({
            id: id,
            type: MsgType.ResolveState,
            data: data,
        });
    }

    // WebSocket functions below

    async connect(receiver: StateResolverReceiver) {
        this.receiver = receiver;
        this.ws = new WebSocket(this.url);
        return new Promise<void>((resolve) => {
            this.ws.addEventListener("open", () => {
                console.log("WS open");
                resolve();
            });
            this.ws.addEventListener("error", this.onWsError.bind(this));
            this.ws.addEventListener("close", this.onWsClose.bind(this));
            this.ws.addEventListener("message", this.onWsMessage.bind(this));
        });
    }

    close() {
        this.ws.close();
    }

    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    sendWs(msg: WebSocketMessage<any>) {
        console.log("send", msg);
        this.ws.send(JSON.stringify(msg));
    }

    onWsClose(ev: CloseEvent) {}
    onWsError(ev: Event) {}
    onWsMessage(ev: MessageEvent) {
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        const msg = JSON.parse(ev.data) as WebSocketMessage<any>;
        console.log("recv", msg);
        switch (msg.type) {
            case MsgType.GetEvent: {
                const data = msg.data as DataGetEvent;
                const response = this.receiver.onGetEventRequest(data);
                data.event = response;
                msg.data = data;
                this.sendWs(msg);
                break;
            }
            case MsgType.ResolveState: {
                const data = msg.data as DataResolveState;
                this.receiver.onResolveStateResponse(msg.id, data);
                break;
            }
        }
    }
}

export { StateResolver, StateResolverTransport, type DataGetEvent, type DataResolveState, type MatrixEvent };
