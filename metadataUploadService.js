import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import { createGenericFile, keypairIdentity } from '@metaplex-foundation/umi';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import { getRpcUrl } from './rpcConfig.js';
import { metadataDocumentHash } from './brandShieldService.js';
import { stampLogoDataUrl } from './logoStampService.js';

export const DEFAULT_IRYS_ADDRESS = 'https://node1.irys.xyz';
export const DEVNET_IRYS_ADDRESS = 'https://devnet.irys.xyz';
export const DEFAULT_IRYS_TIMEOUT_MS = 60000;
export const PLACEHOLDER_TOKEN_IMAGE_URI = 'https://arweave.net/placeholder-token-image';
export const SEALED_TOKEN_NAME = 'Trebuchet Sealed Launch';
export const SEALED_TOKEN_SYMBOL = 'SEALED';

// A metadata document that names its own mint. Copy launchers reuse the
// official metadata URI verbatim, so the document itself tells every reader
// (explorers, wallets, Brand Shield) which mint it belongs to. The hash
// committed on-chain covers the mint too, so the commitment can't be replayed.
export function officialMintNotice(mint) {
  return `Official CA: ${mint}. Any other mint using this metadata is a copy.`;
}

export function tokenMetadataJson({ name, symbol, description, imageUri, mint = null }) {
  const address = String(mint || '').trim();
  if (!address) {
    return {
      name,
      symbol,
      description,
      image: imageUri,
    };
  }
  const notice = officialMintNotice(address);
  const text = String(description || '').trim();
  return {
    name,
    symbol,
    description: text ? `${text}\n\n${notice}` : notice,
    image: imageUri,
    mint: address,
  };
}

export function logoDataUrlToGenericFile(logoBase64) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(logoBase64 || ''));
  if (!match) {
    throw new Error('logo must be a base64 data URL');
  }

  const [, mimeType, base64Data] = match;
  return createGenericFile(Buffer.from(base64Data, 'base64'), 'logo', {
    tags: [{ name: 'Content-Type', value: mimeType }],
  });
}

export function createMetadataUmi({
  rpcUrl = getRpcUrl(),
  irysAddress,
  timeout = DEFAULT_IRYS_TIMEOUT_MS,
} = {}) {
  // If no address explicitly given, auto-detect from RPC URL so devnet
  // uses devnet.irys.xyz instead of node1.irys.xyz.  Passing mainnet
  // unconditionally was the root cause of stuck uploads on devnet.
  const address = irysAddress
    || (rpcUrl.includes('devnet') ? DEVNET_IRYS_ADDRESS : DEFAULT_IRYS_ADDRESS);

  return createUmi(rpcUrl)
    .use(mplTokenMetadata())
    .use(irysUploader({ address, timeout }));
}

export function setMetadataUploaderIdentity(umi, tempWallet) {
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(tempWallet.secretKey);
  umi.use(keypairIdentity(umiKeypair));
  return umi;
}

export function createTokenMetadataUmi(tempWallet, options = {}) {
  return setMetadataUploaderIdentity(createMetadataUmi(options), tempWallet);
}

export async function uploadTokenMetadata({
  umi,
  logoBase64,
  name,
  symbol,
  description,
  mint = null,
  stampLogo = true,
  onProgress,
  logger = console,
  placeholderImageUri = PLACEHOLDER_TOKEN_IMAGE_URI,
  uploadTimeoutMs = DEFAULT_IRYS_TIMEOUT_MS,
  rpcUrl = getRpcUrl(),
}) {
  let imageUri = placeholderImageUri;
  let logoStamped = false;

  // Put the mint on the logo itself: a copy that reuses this image shows the
  // real CA wherever the image is displayed.
  if (logoBase64 && mint && stampLogo) {
    const stamp = stampLogoDataUrl(logoBase64, mint);
    if (stamp.stamped) {
      logoBase64 = stamp.dataUrl;
      logoStamped = true;
      onProgress?.({ stage: 'logo_stamped', mint, bytes: stamp.bytes });
    } else {
      logger.warn?.('Logo left unstamped:', stamp.reason);
      onProgress?.({ stage: 'logo_stamp_skipped', mint, reason: stamp.reason });
    }
  }

  const withTimeout = (promise, label) => {
    if (!uploadTimeoutMs || uploadTimeoutMs <= 0) return promise;
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${uploadTimeoutMs}ms`)), uploadTimeoutMs)
      ),
    ]);
  };

  if (logoBase64) {
    try {
      const logoFile = logoDataUrlToGenericFile(logoBase64);
      const [uploadedImageUri] = await withTimeout(
        umi.uploader.upload([logoFile]),
        'Logo upload'
      );
      imageUri = uploadedImageUri;
      logger.log?.('Logo uploaded:', imageUri);
      onProgress?.({ stage: 'logo_uploaded', imageUri });
    } catch (uploadError) {
      logger.error?.('Error uploading logo:', uploadError);
      imageUri = placeholderImageUri;
      onProgress?.({
        stage: 'logo_upload_failed',
        error: uploadError?.message || String(uploadError),
      });
    }
  }

  // Rewrite arweave.net → gateway.irys.xyz on devnet for both uploaded
  // logos and placeholder images (the rewrite above only ran for uploads).
  if (rpcUrl?.includes('devnet') && imageUri?.includes('arweave.net')) {
    const txId = imageUri.split('/').pop();
    imageUri = `https://gateway.irys.xyz/${txId}`;
  }

  const metadata = tokenMetadataJson({ name, symbol, description, imageUri, mint });
  let metadataUri = await withTimeout(
    umi.uploader.uploadJson(metadata),
    'Metadata upload'
  );
  // The UMI Irys uploader hardcodes arweave.net regardless of network.
  // On devnet, rewrite to the Irys gateway.
  if (rpcUrl?.includes('devnet') && metadataUri?.includes('arweave.net')) {
    const txId = metadataUri.split('/').pop();
    metadataUri = `https://gateway.irys.xyz/${txId}`;
  }
  const metadataHash = metadataDocumentHash(metadata);
  logger.log?.('Metadata uploaded:', metadataUri);
  onProgress?.({ stage: 'metadata_uploaded', metadataUri, imageUri, metadataHash });

  return { metadataUri, imageUri, metadata, metadataHash, logoStamped };
}

export async function uploadSealedPlaceholderMetadata({
  umi,
  commitmentHash,
  onProgress,
  logger = console,
  placeholderImageUri = PLACEHOLDER_TOKEN_IMAGE_URI,
}) {
  const shortCommitment = String(commitmentHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(shortCommitment)) {
    throw new Error('Sealed metadata requires a SHA-256 commitment.');
  }
  const metadata = tokenMetadataJson({
    name: SEALED_TOKEN_NAME,
    symbol: SEALED_TOKEN_SYMBOL,
    description: `Identity committed by Trebuchet: sha256:${shortCommitment}`,
    imageUri: placeholderImageUri,
  });
  const metadataUri = await umi.uploader.uploadJson(metadata);
  logger.log?.('Sealed placeholder metadata uploaded:', metadataUri);
  onProgress?.({
    stage: 'sealed_metadata_prepared',
    onChainMetadataUri: metadataUri,
    metadataCommitment: shortCommitment,
  });
  return { metadataUri, metadata };
}
