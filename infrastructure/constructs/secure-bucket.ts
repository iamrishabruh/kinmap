import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectOwnership,
  StorageClass,
  type IBucket,
  type LifecycleRule,
  type Transition,
} from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

import type { EnvironmentConfig } from '../config/types.js';

export interface SecureBucketProps {
  /**
   * Supplies the default removal policy. Optional so a caller that already
   * knows the policy it wants can pass {@link removalPolicy} on its own.
   */
  readonly config?: EnvironmentConfig;
  /** Physical name. Omit to let CloudFormation generate one. */
  readonly bucketName?: string;
  /** Supply a customer-managed key to upgrade from SSE-S3 to SSE-KMS. */
  readonly encryptionKey?: IKey;
  /** Where S3 server access logs for this bucket are delivered. */
  readonly serverAccessLogsBucket?: IBucket;
  /** Prefix within {@link serverAccessLogsBucket}; defaults to the construct id. */
  readonly serverAccessLogsPrefix?: string;
  /** Defaults to true. Turn off only for buckets that are pure spill space. */
  readonly versioned?: boolean;
  /** Replaces the generated lifecycle rules entirely when provided. */
  readonly lifecycleRules?: LifecycleRule[];
  /** Defaults to BUCKET_OWNER_ENFORCED — ACLs disabled. */
  readonly objectOwnership?: ObjectOwnership;
  /** Defaults to `config.removalPolicy`, and to RETAIN when neither is given. */
  readonly removalPolicy?: RemovalPolicy;
  /** Days before a current object expires. Omit to keep objects forever. */
  readonly expirationDays?: number;
  /** Days before a non-current version is deleted. Defaults to 90. */
  readonly noncurrentVersionExpirationDays?: number;
  /** Days before an object transitions to Infrequent Access. */
  readonly transitionToInfrequentAccessDays?: number;
  /** Days before an object transitions to Glacier Instant Retrieval. */
  readonly transitionToGlacierDays?: number;
  /** Emit S3 events to EventBridge. */
  readonly eventBridgeEnabled?: boolean;
}

/**
 * An S3 bucket with the settings this product is not willing to make optional:
 *
 *  - public access blocked at the bucket level, in all four dimensions;
 *  - a bucket policy that denies any request not using TLS, and denies TLS
 *    below 1.2;
 *  - encryption at rest, SSE-S3 by default and SSE-KMS when a key is supplied,
 *    with an S3 Bucket Key so KMS request cost stays flat;
 *  - ACLs disabled, so object ownership cannot be split with another account;
 *  - versioning, so an overwrite or delete is recoverable;
 *  - server access logging to a separate bucket;
 *  - lifecycle rules that clean up aborted multipart uploads and expire old
 *    versions instead of paying to store them forever.
 *
 * TLS enforcement and public-access blocking are not exposed as props: they are
 * always on and must not be weakened at a call site.
 */
export class SecureBucket extends Bucket {
  constructor(scope: Construct, id: string, props: SecureBucketProps) {
    // Fails safe: with neither a config nor an explicit policy the bucket is
    // retained, because deleting a bucket that might hold user data by default
    // is not a mistake this construct is willing to make.
    const removalPolicy =
      props.removalPolicy ?? props.config?.removalPolicy ?? RemovalPolicy.RETAIN;
    const versioned = props.versioned ?? true;

    super(scope, id, {
      bucketName: props.bucketName,

      // Encryption: a customer-managed key when one is supplied, SSE-S3
      // otherwise. Bucket keys cut KMS calls by ~99% for high-volume prefixes.
      encryption:
        props.encryptionKey !== undefined ? BucketEncryption.KMS : BucketEncryption.S3_MANAGED,
      encryptionKey: props.encryptionKey,
      bucketKeyEnabled: props.encryptionKey !== undefined,

      // Public access is blocked in all four dimensions; nothing in this
      // product is ever served straight from S3.
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,

      // Adds an explicit Deny for aws:SecureTransport=false and for stale TLS.
      enforceSSL: true,
      minimumTLSVersion: 1.2,

      versioned,
      objectOwnership: props.objectOwnership ?? ObjectOwnership.BUCKET_OWNER_ENFORCED,
      eventBridgeEnabled: props.eventBridgeEnabled ?? false,

      removalPolicy,
      // Only ever true where the removal policy already says the data is
      // disposable, i.e. development.
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,

      serverAccessLogsBucket: props.serverAccessLogsBucket,
      serverAccessLogsPrefix:
        props.serverAccessLogsBucket !== undefined
          ? (props.serverAccessLogsPrefix ?? `${id}/`)
          : undefined,

      lifecycleRules: props.lifecycleRules ?? buildLifecycleRules(props, versioned),
    });
  }
}

function buildLifecycleRules(props: SecureBucketProps, versioned: boolean): LifecycleRule[] {
  const rules: LifecycleRule[] = [
    {
      id: 'abort-incomplete-multipart-uploads',
      enabled: true,
      abortIncompleteMultipartUploadAfter: Duration.days(7),
    },
  ];

  if (versioned) {
    rules.push({
      id: 'expire-noncurrent-versions',
      enabled: true,
      noncurrentVersionExpiration: Duration.days(props.noncurrentVersionExpirationDays ?? 90),
      noncurrentVersionsToRetain: 3,
    });
  }

  const transitions: Transition[] = [];
  if (props.transitionToInfrequentAccessDays !== undefined) {
    transitions.push({
      storageClass: StorageClass.INFREQUENT_ACCESS,
      transitionAfter: Duration.days(props.transitionToInfrequentAccessDays),
    });
  }
  if (props.transitionToGlacierDays !== undefined) {
    transitions.push({
      storageClass: StorageClass.GLACIER_INSTANT_RETRIEVAL,
      transitionAfter: Duration.days(props.transitionToGlacierDays),
    });
  }
  if (transitions.length > 0) {
    rules.push({ id: 'tier-down-cold-objects', enabled: true, transitions });
  }

  if (props.expirationDays !== undefined) {
    rules.push({
      id: 'expire-current-objects',
      enabled: true,
      expiration: Duration.days(props.expirationDays),
    });
  }

  return rules;
}
