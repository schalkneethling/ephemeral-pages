declare module "yauzl" {
  import type { Readable } from "node:stream";

  export type Entry = {
    fileName: string;
    versionMadeBy: number;
    compressionMethod: number;
    uncompressedSize: number;
    externalFileAttributes: number;
    canDecodeFileData(): boolean;
    isEncrypted(): boolean;
  };

  export type ZipFile = {
    entryCount: number;
    eachEntry(): AsyncIterableIterator<Entry>;
    openReadStreamPromise(entry: Entry): Promise<Readable>;
  };

  const yauzl: {
    fromBufferPromise(
      buffer: Buffer,
      options: { strictFileNames: boolean; validateEntrySizes: boolean },
    ): Promise<ZipFile>;
  };

  export default yauzl;
}
