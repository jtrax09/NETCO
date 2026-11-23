import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  getFirestore,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { handleFirestoreError, OperationType } from './firestoreErrors.ts';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleAuthProvider = new GoogleAuthProvider();

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Firebase Firestore client appears offline; check configuration.');
    }
  }
}

void testConnection();

export async function syncWorkspacePreference(
  uid: string,
  theme: 'dark' | 'light',
  compactTables: boolean
): Promise<void> {
  const path = `workspace_prefs/${uid}`;
  try {
    await setDoc(
      doc(db, 'workspace_prefs', uid),
      {
        ownerUid: uid,
        theme,
        compactTables,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncPublicPackageToFirestore(pkg: {
  id: string;
  name: string;
  description?: string | null;
  category: string;
  priceTzs: number;
  durationMinutes: number;
  downloadKbps: number;
  uploadKbps: number;
  isActive: boolean;
}): Promise<void> {
  if (!auth.currentUser) return;
  const path = `packages/${pkg.id}`;
  try {
    await setDoc(doc(db, 'packages', pkg.id), {
      packageId: pkg.id,
      name: pkg.name.slice(0, 80),
      ...(pkg.description ? { description: pkg.description.slice(0, 300) } : {}),
      category: pkg.category,
      priceTzs: pkg.priceTzs,
      durationMinutes: pkg.durationMinutes,
      downloadKbps: pkg.downloadKbps,
      uploadKbps: pkg.uploadKbps,
      isActive: Boolean(pkg.isActive),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    // Log structured context without blocking operational SQLite workflow
    console.warn('Firestore package mirror sync warning:', path, error);
  }
}
