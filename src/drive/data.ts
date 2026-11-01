import { createDriveClient } from "./auth";

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

export async function fetchDriveData(
  folderId: string,
): Promise<DriveFolderData> {
  const drive = await createDriveClient();

  const [folderInfo, filesResponse] = await Promise.all([
    drive.files.get({
      fileId: folderId,
      fields: "id, name, parents",
    }),
    drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        "files(id, name, mimeType, webViewLink, webContentLink, size, modifiedTime)",
      pageSize: 1000,
      orderBy: "name",
    }),
  ]);

  return {
    files: (filesResponse.data.files ?? []) as DriveFile[],
    parentFolderId: folderInfo.data.parents?.[0] ?? null,
    currentFolder: {
      id: folderInfo.data.id ?? "",
      name: folderInfo.data.name ?? "",
    },
  };
}