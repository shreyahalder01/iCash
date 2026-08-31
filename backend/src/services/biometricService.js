/**
 * Biometric Provider Interface & Abstraction
 *
 * In this deployment, we implement:
 * 1. DemoBiometricProvider (Server-side Euclidean distance verification on 128D facial feature vectors)
 * 2. ProductionBiometricProvider (Stub/Interface for UIDAI RD Service or certified biometric HSM)
 */

class IBiometricProvider {
  async enroll(_userId, _descriptors) {
    throw new Error('enroll() not implemented');
  }
  async verify(_storedDescriptors, _liveDescriptor) {
    throw new Error('verify() not implemented');
  }
}

/**
 * Demo Biometric Provider using Euclidean distance calculations on normalized 128-element Float32/numeric arrays.
 */
class DemoBiometricProvider extends IBiometricProvider {
  constructor(threshold = 0.6) {
    super();
    this.name = 'DEMO_FACIAL_EMBEDDINGS';
    this.matchThreshold = threshold;
  }

  euclideanDistance(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < vecA.length; i++) {
      const diff = vecA[i] - vecB[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  async enroll(userId, descriptors) {
    const reference = `BIO_DEMO_${userId.slice(0, 8)}_${Date.now()}`;
    return {
      provider: this.name,
      reference,
      descriptors: descriptors || [],
    };
  }

  async verify(storedDescriptors, liveDescriptor) {
    if (!storedDescriptors || !Array.isArray(storedDescriptors) || storedDescriptors.length === 0) {
      return {
        matched: false,
        confidence: 0,
        distance: Infinity,
        reason: 'No biometric profile found for comparison.',
      };
    }

    if (!liveDescriptor || !Array.isArray(liveDescriptor) || liveDescriptor.length < 128) {
      return {
        matched: false,
        confidence: 0,
        distance: Infinity,
        reason: 'Invalid live biometric descriptor format.',
      };
    }

    let minDistance = Infinity;
    for (const storedVec of storedDescriptors) {
      const dist = this.euclideanDistance(storedVec, liveDescriptor);
      if (dist < minDistance) {
        minDistance = dist;
      }
    }

    const matched = minDistance < this.matchThreshold;
    const confidence = Math.max(0, Math.min(1, 1 - minDistance / this.matchThreshold));

    return {
      matched,
      distance: Number(minDistance.toFixed(4)),
      confidence: Number(confidence.toFixed(4)),
      provider: this.name,
    };
  }
}

/**
 * Production Biometric Provider interface for UIDAI / Certified Biometric Hardware.
 */
class ProductionBiometricProvider extends IBiometricProvider {
  constructor(apiUrl, apiKey) {
    super();
    this.name = 'UIDAI_RD_SERVICE_STUB';
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  async enroll(userId, _descriptors) {
    // In production, this issues an encrypted token or device certificate
    return {
      provider: this.name,
      reference: `UIDAI_REF_${userId.slice(0, 8)}`,
      descriptors: null, // Raw biometric data is never stored in DB in production
    };
  }

  async verify(_storedReference, _liveAuthToken) {
    // Real UIDAI Auth 2.5 API request via signed XML/JSON payload
    throw new Error(
      'Production UIDAI integration requires active license and certified HSM token.'
    );
  }
}

// Active provider selection
const activeProvider =
  process.env.BIOMETRIC_PROVIDER === 'production'
    ? new ProductionBiometricProvider(
        process.env.BIOMETRIC_PROVIDER_URL,
        process.env.BIOMETRIC_API_KEY
      )
    : new DemoBiometricProvider(0.6);

module.exports = {
  biometricService: activeProvider,
  DemoBiometricProvider,
  ProductionBiometricProvider,
};
