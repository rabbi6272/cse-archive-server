import { google, type drive_v3 } from "googleapis";
import fs from "fs";
import path from "path";
import { env } from "./env";

const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

export const DRIVE_CONFIG = {
  ROOT_FOLDER_ID: "1xbyCdj3XQ9AsCCF8ImI13HCo25JEhgUJ",
};

export const getRootFolderId = (): string => DRIVE_CONFIG.ROOT_FOLDER_ID;

export async function createDriveAuthClient(): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const clientEmail = env.GOOGLE_CLIENT_EMAIL?.trim();
  const privateKey = env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();

  let auth: InstanceType<typeof google.auth.GoogleAuth>;

  if (clientEmail && privateKey) {
    auth = new google.auth.GoogleAuth({
      credentials: { client_email: clientEmail, private_key: privateKey },
      scopes: SCOPES,
    });
  } else {
    const keyFilePath = path.join(process.cwd(), "credentials.json");
    if (!fs.existsSync(keyFilePath)) {
      throw new Error("Google Drive credentials not found");
    }
    auth = new google.auth.GoogleAuth({ keyFile: keyFilePath, scopes: SCOPES });
  }

  const client = await auth.getClient();
  return client as InstanceType<typeof google.auth.OAuth2>;
}

export async function createDriveClient(): Promise<drive_v3.Drive> {
  const authClient = await createDriveAuthClient();
  return google.drive({ version: "v3", auth: authClient });
}
