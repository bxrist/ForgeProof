import { parseLifeosRequestIdentity, requireLifeosRequestId } from './lifeosRequestIdentity.mjs';

// Dependencies are the existing service proof, schema, signer and Git adapter.
export function registerLifeosAttestationRoutes(app, deps) {
  app.post('/api/lifeos/attest', deps.limiter, async (req, res) => {
    const started = performance.now();
    let stage = 'authorization', proofMs = null, issuanceStarted = null;
    res.once?.('finish', () => {
      const totalMs = Math.round(performance.now() - started);
      if (totalMs < 3000 && res.statusCode < 500) return;
      console.warn('[lifeos] Request timing', JSON.stringify({
        stage, status: res.statusCode, totalMs, proofMs,
        issuanceMs: issuanceStarted === null ? null : Math.round(performance.now() - issuanceStarted),
        category: res.statusCode >= 500 ? 'internal_failure' : 'slow_request',
      }));
    });
    try {
      const proof = await deps.proveControl(req.headers.authorization);
      proofMs = Math.round(performance.now() - started);
      stage = 'validation';
      const identity = parseLifeosRequestIdentity(req.headers['idempotency-key'], req.body?.signedAt);
      if (identity && !deps.getStorage()) return res.status(503).json({message:'Durable Git storage required'});
      const parsed = deps.parseBody(req.body);
      if (!parsed.success) return res.status(400).json({message:'Invalid attestation request'});
      if ((parsed.data.attestation_type && parsed.data.attestation_type !== 'origin') ||
          parsed.data.parent_attestation_id || parsed.data.repository)
        return res.status(400).json({message:'LifeOS service accepts standalone origin receipts only'});
      await deps.validateLifecycle?.(proof, parsed.data);
      stage = 'issuance';
      issuanceStarted = performance.now();
      const receipt = await deps.createReceipt(proof.userId,
        {...parsed.data, metadata:{...parsed.data.metadata, source:'lifeos_service', metering:'internal'}},
        // Transport observations must not change an opted-in semantic fingerprint.
        identity ? null : deps.detectCountry(req), undefined, proof, identity);
      return res.status(201).json({...receipt, metering:'internal'});
    } catch (error) {
      return res.status(error.status || 500).json({
        message: [400,403].includes(error.status) ? error.message : 'LifeOS attestation failed',
      });
    }
  });
  app.get('/api/lifeos/attest/status/:requestId', deps.limiter, async (req, res) => {
    res.setHeader?.('Cache-Control', 'no-store');
    try {
      const requestId = requireLifeosRequestId(req.params.requestId);
      const proof = await deps.proveControl(req.headers.authorization);
      const gitStorage = deps.getStorage(); // Resolve after proof binds the request principal.
      if (!gitStorage) return res.status(503).json({message:'Status unverified'});
      const receipt = await gitStorage.getAttestationByRequestId(requestId, async state => {
        const row = state.records.apiKeys[proof.apiKeyId];
        const matches = !!row && await gitStorage.custody.matches(gitStorage.custodyScope, String(row.credentialRef), proof.keyHash);
        await deps.verifyState(proof, proof.userId, state, matches);
      });
      if (!receipt) return res.status(404).json({message:'Not found or unverified'});
      if (receipt.lifecycleEvidence)
        await deps.validateRecovered?.(proof, receipt.lifecycleEvidence.payload.project);
      return res.json({...receipt, metering:'internal'});
    } catch (error) {
      return res.status(error.status === 403 ? 403 : error.status === 400 ? 400 : 503)
        .json({message:'Not found or unverified'});
    }
  });
}
