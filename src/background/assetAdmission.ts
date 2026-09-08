import { sameDocumentBinding, type DocumentBinding } from "./routerState.js";

/**
 * BB-AUD-09. Whether a controller's `asset.fetch` may open a transfer at all.
 *
 * The service worker decided this inline, beside `sendAssetError` and the content dispatch, so
 * every refusal could only be reached by driving a whole capture through a socket and a stubbed
 * Chrome. The decision itself touches neither: it reads the asset it recovered, the document
 * currently bound to that asset's tab, and the transfer table, and answers with one verdict.
 * Sending the refusal, deleting the forgotten asset and dispatching the accepted transfer stay
 * in the entry.
 *
 * The answer is a named verdict rather than a boolean because the refusals are not
 * interchangeable: one means the asset is gone, one means the controller reused a transfer id,
 * one means the page that produced the asset is no longer there — and only the last of those
 * makes the entry forget the asset. A boolean would have collapsed them into "no" and left the
 * caller to re-derive which "no" it was from the state it just passed in.
 */

export type AssetFetchRequest = {
  transferId: string;
  assetId: string;
  maxBytes: number;
};

export type RegisteredAssetView = {
  asset: { id: string; downloadAvailable: boolean };
  binding: DocumentBinding;
};

export type AssetAdmissionInput = {
  request: AssetFetchRequest;
  /** The asset the entry recovered, or nothing if no document still holds it. */
  registered?: RegisteredAssetView | undefined;
  /** The document bound to the asset's tab right now, or nothing if the tab holds none. */
  currentDocument?: DocumentBinding | undefined;
  /** Whether the transfer id the controller chose is already open. */
  transferIdInUse: boolean;
};

export type AdmittedAssetTransfer = {
  transferId: string;
  assetId: string;
  binding: DocumentBinding;
  maxBytes: number;
  receivedBytes: number;
  nextSequence: number;
  started: boolean;
};

export type AssetAdmissionVerdict =
  | "admitted"
  | "asset-unknown"
  | "asset-not-downloadable"
  | "transfer-exists"
  | "document-changed"
  | "budget-invalid";

export type AssetAdmission =
  | {
      verdict: "admitted";
      transfer: AdmittedAssetTransfer;
    }
  | {
      verdict: Exclude<AssetAdmissionVerdict, "admitted">;
      code: string;
      message: string;
      /** Whether the entry must drop its record of the asset as part of refusing. */
      forgetAsset: boolean;
    };

const validBudget = (maxBytes: number): boolean =>
  typeof maxBytes === "number" && Number.isSafeInteger(maxBytes) && maxBytes > 0;

/**
 * The refusals keep the order the entry has always applied them in, so a request that fails more
 * than one check is refused with the same code and the same words it was refused with before.
 */
export const admitAssetFetch = (input: AssetAdmissionInput): AssetAdmission => {
  const { request, registered, currentDocument } = input;
  if (!registered || registered.asset.id !== request.assetId) {
    return {
      verdict: "asset-unknown",
      code: "ASSET_UNAVAILABLE",
      message: "The browser asset is no longer available",
      forgetAsset: false,
    };
  }
  if (!registered.asset.downloadAvailable) {
    return {
      verdict: "asset-not-downloadable",
      code: "ASSET_UNAVAILABLE",
      message: "The browser asset is no longer available",
      forgetAsset: false,
    };
  }
  if (input.transferIdInUse) {
    return {
      verdict: "transfer-exists",
      code: "TRANSFER_EXISTS",
      message: "The browser asset transfer already exists",
      forgetAsset: false,
    };
  }
  if (!currentDocument || !sameDocumentBinding(currentDocument, registered.binding)) {
    return {
      verdict: "document-changed",
      code: "ASSET_DOCUMENT_CHANGED",
      message: "The browser document that produced the asset has changed",
      forgetAsset: true,
    };
  }
  if (!validBudget(request.maxBytes)) {
    return {
      verdict: "budget-invalid",
      code: "ASSET_REQUEST_INVALID",
      message: "The browser asset transfer budget is not a usable byte count",
      forgetAsset: false,
    };
  }
  // An accepted admission carries everything the transfer needs to begin and nothing that could
  // change under it: the binding is copied, so a later re-registration of the tab cannot edit a
  // transfer that was admitted against the document as it stood here.
  return {
    verdict: "admitted",
    transfer: {
      transferId: request.transferId,
      assetId: request.assetId,
      binding: { ...registered.binding },
      maxBytes: request.maxBytes,
      receivedBytes: 0,
      nextSequence: 0,
      started: false,
    },
  };
};
