declare type SQLiteCompatibleType = number | string | null | Uint8Array;

declare module "@effect/wa-sqlite/dist/wa-sqlite.mjs" {
  const SQLiteESMFactory: (config?: object) => Promise<unknown>;
  export default SQLiteESMFactory;
}

declare module "@effect/wa-sqlite/src/examples/OPFSCoopSyncVFS.js" {
  export class OPFSCoopSyncVFS {
    static create(name: string, module: unknown): Promise<OPFSCoopSyncVFS>;
  }
}
