/** Local control protocol. Transport delivery never implies execution. */
export interface LocalStatus {
  identityId: string;
  deviceId: string;
  online: boolean;
  certificateExpiresAt: number;
  transportError: boolean;
}

export interface LocalMessageState {
  messageId: string;
  state: "queued" | "delivered";
}

export interface LocalInboxMessage {
  messageId: string;
  peer: string;
  text: string;
  createdAt: number;
}

export interface LocalPresence {
  peer: string;
  online: boolean | null;
}
