import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import { createGenericFile, keypairIdentity } from '@metaplex-foundation/umi';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import { getRpcUrl } from './rpcConfig.js';

export const DEFAULT_IRYS_ADDRESS = 'https://node1.irys.xyz';
export const DEVNET_IRYS_ADDRESS = 'https://devnet.irys.xyz';
export const DEFAULT_IRYS_TIMEOUT_MS = 60000;
export const PLACEHOLDER_TOKEN_IMAGE_URI = 'https://arweave.net/placeholder-token-image';

export function tokenMetadataJson({ name, symbol, description, imageUri }) {
  return {
    name,
    symbol,
    description,
    image: imageUri,
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
  onProgress,
  logger = console,
  placeholderImageUri = PLACEHOLDER_TOKEN_IMAGE_URI,
  uploadTimeoutMs = DEFAULT_IRYS_TIMEOUT_MS,
  rpcUrl = getRpcUrl(),
}) {
  let imageUri = placeholderImageUri;

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
      // Fix devnet gateway (same logic as metadata URI)
      if (rpcUrl?.includes('devnet') && imageUri?.includes('arweave.net')) {
        const txId = imageUri.split('/').pop();
        imageUri = `https://gateway.irys.xyz/${txId}`;
      }
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

  const metadata = tokenMetadataJson({ name, symbol, description, imageUri });
  let metadataUri = await withTimeout(
    umi.uploader.uploadJson(metadata),
    'Metadata upload'
  );
  // The UMI Irys uploader hardcodes arweave.net regardless of network.
  // On devnet, the data may settle on a different gateway or stay on Irys
  // nodes.  Rewrite to the Irys gateway when we detect devnet.
  if (rpcUrl?.includes('devnet') && metadataUri?.includes('arweave.net')) {
    const txId = metadataUri.split('/').pop();
    metadataUri = `https://gateway.irys.xyz/${txId}`;
  }

  logger.log?.('Metadata uploaded:', metadataUri);
  onProgress?.({ stage: 'metadata_uploaded', metadataUri, imageUri });

  return { metadataUri, imageUri, metadata };
}
