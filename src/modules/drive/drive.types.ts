import { z } from "zod";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  webViewLink?: string;
  webContentLink?: string;
  size?: string;
  modifiedTime?: string;
}

export interface DriveFolderData {
  files: DriveFile[];
  parentFolderId: string | null;
  currentFolder: { id: string; name: string };
}

export interface WatchInfo {
  channelId: string;
  resourceId: string | null;
  expiration: string | null;
}

export interface LastNotification {
  at: string;
  state: string | null;
  messageNumber: string | null;
  channelId: string | null;
}

export interface DriveChange {
  fileId?: string;
  removed?: boolean;
  file?: {
    id?: string;
    name?: string;
    mimeType?: string;
    parents?: string[];
    modifiedTime?: string;
  } | null;
}

export interface ProcessChangesResult {
  changes: DriveChange[];
  newStartPageToken: string | null;
  hasRelevantChanges: boolean;
}

export type WatchState = WatchInfo & { renewed?: boolean };

export const VALID_ACTIONS = ["setup", "revalidate", "delete", "renew", "status"] as const;
export type AdminAction = (typeof VALID_ACTIONS)[number];

export const folderIdSchema = z.object({
  folderId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{10,80}$/, "Invalid Folder ID format"),
});
