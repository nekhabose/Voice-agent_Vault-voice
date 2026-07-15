"""Ledgerline LiveKit voice worker.

The audio binding around the TypeScript ``CallRuntime`` (packages/runtime). The
state machine, extractor, classifier, and validators — everything consequential
— live in TypeScript and are tested without a phone. This package performs the
``Effect[]`` they produce against a real microphone and a real SIP trunk.
"""
