import { Annotations, CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import {
  Certificate,
  CertificateValidation,
  type ICertificate,
} from 'aws-cdk-lib/aws-certificatemanager';
import {
  AccessLevel,
  AllowedMethods,
  CachedMethods,
  CachePolicy,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  AaaaRecord,
  ARecord,
  HostedZone,
  RecordTarget,
  type IHostedZone,
} from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import type { Construct } from 'constructs';

import { cdkEnvironment, type BaseStackProps, type FoundationResources } from '../config/index.js';
import { SecureBucket } from '../constructs/secure-bucket.js';

/**
 * The public web surface: the marketing and consent site, and the privacy
 * documents the mobile app links to (`docs/privacy/*`).
 *
 * Nothing here is authenticated and nothing here holds user data, so the origin
 * bucket stays private — CloudFront reaches it through an Origin Access
 * Control, and the bucket blocks public access in all four dimensions. The real
 * security surface is the response headers, which is why they are declared
 * explicitly instead of inherited from a managed policy: this is the domain
 * somebody lands on while deciding whether to trust us with their location, and
 * a permissive `Permissions-Policy` there would hand `geolocation` to anything
 * the page ever embeds.
 *
 * No context lookup is performed: the hosted zone and both certificates come
 * from the foundation stack, which imported the zone from configuration.
 */

/**
 * The site is static and same-origin. `default-src 'none'` means every
 * directive below is an explicit allowance rather than a narrowing of a
 * permissive default.
 */
function contentSecurityPolicy(apiDomain: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' https://${apiDomain}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/** Every powerful browser feature is denied; the site needs none of them. */
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'ambient-light-sensor=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

export interface WebStackProps extends BaseStackProps {
  /** Shared account resources, when the foundation is wired in. */
  readonly foundation?: FoundationResources;
  /**
   * Route53 zone hosting {@link EnvironmentConfig.domain}. Defaults to the
   * foundation's zone, then to `config.hostedZoneId`. Never looked up.
   */
  readonly hostedZoneId?: string;
  /**
   * us-east-1 certificate covering the site's names. CloudFront accepts
   * certificates from no other region, so pass the foundation's edge
   * certificate when this stack is not itself in us-east-1.
   */
  readonly certificateArn?: string;
  /** Extra names to serve. Defaults to the apex domain alongside the web host. */
  readonly additionalDomainNames?: readonly string[];
}

export class WebStack extends Stack {
  public readonly siteBucket: SecureBucket;
  public readonly distribution: Distribution;
  public readonly certificate: ICertificate;

  public constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, {
      ...props,
      env: cdkEnvironment(props.config),
      description: `Kinmap ${props.config.envName} — public site behind CloudFront with a private S3 origin`,
      // The CloudFront certificate may live in the foundation's us-east-1 edge
      // stack when the primary region is not us-east-1.
      crossRegionReferences: true,
    });

    const { config, foundation } = props;

    // -----------------------------------------------------------------------
    // Private origin
    // -----------------------------------------------------------------------

    // Every read of this bucket arrives through the OAC, so CloudFront's own
    // logs — not S3 server access logs — are the meaningful record. Pointing
    // the logs at the foundation's bucket would also make the foundation stack
    // depend on this one, which is a cycle.
    this.siteBucket = new SecureBucket(this, 'SiteBucket', {
      config,
      noncurrentVersionExpirationDays: 30,
    });

    // -----------------------------------------------------------------------
    // DNS and certificate. Both are imported rather than looked up, so synth
    // needs no credentials.
    // -----------------------------------------------------------------------

    const zone: IHostedZone =
      foundation?.hostedZone ??
      HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.hostedZoneId ?? config.hostedZoneId,
        zoneName: config.domain,
      });

    if (props.certificateArn !== undefined) {
      this.certificate = Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn);
    } else if (foundation !== undefined && config.region === config.edgeRegion) {
      this.certificate = foundation.cloudFrontCertificate;
    } else {
      if (config.region !== config.edgeRegion) {
        Annotations.of(this).addWarningV2(
          '@kinmap/web-stack:certificate-region',
          `CloudFront only accepts certificates from ${config.edgeRegion}, but this stack is in ` +
            `${config.region}. Pass certificateArn from the foundation's edge stack, or deploy ` +
            `WebStack into ${config.edgeRegion}.`,
        );
      }
      this.certificate = new Certificate(this, 'Certificate', {
        domainName: config.webDomain,
        subjectAlternativeNames: config.webDomain === config.domain ? undefined : [config.domain],
        validation: CertificateValidation.fromDns(zone),
      });
    }

    // -----------------------------------------------------------------------
    // Response headers
    // -----------------------------------------------------------------------

    const responseHeaders = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${config.resourcePrefix}-security-headers`,
      comment: 'Strict security headers for the Kinmap public site',
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentSecurityPolicy: {
          contentSecurityPolicy: contentSecurityPolicy(config.apiDomain),
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: PERMISSIONS_POLICY, override: true },
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
          { header: 'Cross-Origin-Resource-Policy', value: 'same-origin', override: true },
          { header: 'X-Permitted-Cross-Domain-Policies', value: 'none', override: true },
        ],
      },
      removeHeaders: ['server'],
    });

    // -----------------------------------------------------------------------
    // Distribution
    // -----------------------------------------------------------------------

    const domainNames = [
      config.webDomain,
      ...(props.additionalDomainNames ??
        (config.webDomain === config.domain ? [] : [config.domain])),
    ];

    this.distribution = new Distribution(this, 'Distribution', {
      comment: `Kinmap ${config.envName} site`,
      domainNames,
      certificate: this.certificate,
      defaultRootObject: 'index.html',
      httpVersion: HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: config.isProduction ? PriceClass.PRICE_CLASS_ALL : PriceClass.PRICE_CLASS_100,
      enableIpv6: true,
      defaultBehavior: {
        // Origin Access Control. CDK writes the bucket policy that allows this
        // distribution and nothing else, so the bucket itself stays private.
        origin: S3BucketOrigin.withOriginAccessControl(this.siteBucket, {
          originAccessLevels: [AccessLevel.READ],
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: OriginRequestPolicy.CORS_S3_ORIGIN,
        responseHeadersPolicy: responseHeaders,
        compress: true,
      },
      errorResponses: [
        // A missing object behind OAC surfaces as 403; showing the 404 page is
        // both honest and avoids advertising which keys exist.
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.minutes(5),
        },
      ],
    });

    // -----------------------------------------------------------------------
    // DNS
    // -----------------------------------------------------------------------

    const target = RecordTarget.fromAlias(new CloudFrontTarget(this.distribution));

    for (const [index, recordName] of domainNames.entries()) {
      const suffix = index === 0 ? 'Primary' : `Alias${index}`;
      new ARecord(this, `ARecord${suffix}`, {
        zone,
        recordName,
        target,
        comment: `Kinmap ${config.envName} site`,
      });
      new AaaaRecord(this, `AaaaRecord${suffix}`, {
        zone,
        recordName,
        target,
        comment: `Kinmap ${config.envName} site`,
      });
    }

    new CfnOutput(this, 'SiteBucketNameOutput', {
      value: this.siteBucket.bucketName,
      description: 'Private origin bucket the site is published into',
    });
    new CfnOutput(this, 'DistributionIdOutput', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution to invalidate after publishing the site',
    });
    new CfnOutput(this, 'SiteUrlOutput', {
      value: `https://${config.webDomain}`,
      description: 'Public site URL',
    });
  }
}
