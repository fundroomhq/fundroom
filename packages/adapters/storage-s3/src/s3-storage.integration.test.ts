import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { describeObjectStorageContract } from "@fundroom/storage/testing";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createS3Storage } from "./s3-storage.js";

/*
 * Runs the port contract against a local S3-compatible server. SeaweedFS is the image
 * design/07 §1.2 lists for the Compose stack (Apache-2, single binary, `weed server -s3`),
 * so it is what CI exercises. Override with FUNDROOM_TEST_S3_IMAGE. With no `-s3.config`
 * SeaweedFS accepts any credentials, including the presigned URLs the contract fetches.
 * Known SeaweedFS gaps the adapter compensates for: `x-amz-checksum-sha256` is not verified
 * (the adapter recomputes it), an unsatisfiable range answers 200 with an empty body (the
 * adapter turns that into an error), and `response-content-*` presign overrides are ignored
 * (not compensated; the contract skips that assertion here).
 */
const IMAGE = process.env["FUNDROOM_TEST_S3_IMAGE"] ?? "chrislusf/seaweedfs:3.97";
const S3_PORT = 8333;

async function startSeaweed(): Promise<{ endpoint: string; stop(): Promise<void> }> {
  const container: StartedTestContainer = await new GenericContainer(IMAGE)
    .withCommand([
      "server",
      "-s3",
      "-dir=/data",
      "-ip.bind=0.0.0.0",
      "-master.volumeSizeLimitMB=64",
      "-volume.max=8",
    ])
    .withExposedPorts(S3_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(S3_PORT)}`;
  return { endpoint, stop: () => container.stop().then(() => {}) };
}

async function ensureBucket(endpoint: string, bucket: string): Promise<void> {
  const probe = createS3Storage({
    bucket,
    endpoint,
    accessKeyId: "fundroom",
    secretAccessKey: "fundroom",
    forcePathStyle: true,
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await probe.client.send(new CreateBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") return;
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

describeObjectStorageContract("s3 (SeaweedFS)", {
  create: async () => {
    const seaweed = await startSeaweed();
    await ensureBucket(seaweed.endpoint, "fundroom-test");
    const storage = createS3Storage({
      bucket: "fundroom-test",
      endpoint: seaweed.endpoint,
      accessKeyId: "fundroom",
      secretAccessKey: "fundroom",
      forcePathStyle: true,
      keyPrefix: "prefix/",
    });
    return { storage, cleanup: () => seaweed.stop() };
  },
  presignResponseOverrides: false,
});
