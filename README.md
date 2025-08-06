# Token Distributor

[![Anchor Version](https://img.shields.io/badge/Anchor-0.31.1-blue.svg)](https://www.anchor-lang.com/)
[![Solana Version](https://img.shields.io/badge/Solana-2.1.16-purple.svg)](https://solana.com/)

A Solana program for distributing tokens to multiple recipients using merkle tree verification. This program enables efficient and secure token airdrops with advanced features for managing large-scale token distributions across the Solana ecosystem.

## Project Structure

```
Boost-TokenDistributor-Solana/
├── programs/
│   └── token_distributor/
│       ├── Cargo.toml
│       ├── Xargo.toml
│       └── src/
│           ├── constants.rs
│           ├── error.rs
│           ├── event.rs
│           ├── instructions/
│           │   ├── claim.rs
│           │   ├── close_claim_status.rs
│           │   ├── create_distributor.rs
│           │   ├── mod.rs
│           │   ├── set_merkle_root.rs
│           │   ├── set_time.rs
│           │   └── withdraw.rs
│           ├── lib.rs
│           ├── state/
│           │   ├── claim_state.rs
│           │   ├── distributor_state.rs
│           │   ├── mod.rs
│           │   └── nonce_state.rs
│           ├── test/
│           │   ├── mod.rs
│           │   └── test_merkle.rs
│           └── utils/
│               ├── mod.rs
│               ├── token.rs
│               └── verify.rs
├── tests/
│   ├── token_distributor.ts
│   ├── token_distributor_bankrun.ts
│   ├── token_distributor_bankrun_simple.ts
│   ├── token_distributor_litesvm.ts
│   └── utils/
│       └── merkle_tree.ts
├── Anchor.toml
├── Cargo.toml
├── package.json
└── README.md
```

- **programs/token_distributor/**: Core Solana program implementation with all instructions and state management
- **tests/**: Comprehensive test suite including multiple testing frameworks (Bankrun, LiteSVM, and standard Anchor tests)

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm/yarn
- [Anchor Framework](https://book.anchor-lang.com/) v0.31.1+
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools)
- Basic understanding of Solana and TypeScript

### Installation & Setup

```bash
# Install dependencies
yarn install

# Build the program
anchor build

# Run tests
anchor test
```

### Testing

The project includes multiple test suites for comprehensive validation:

- **Standard Anchor Tests**: `tests/token_distributor.ts` - Traditional Anchor testing
- **Bankrun Tests**: `tests/token_distributor_bankrun.ts` - High-performance testing framework
- **LiteSVM Tests**: `tests/token_distributor_litesvm.ts` - Fast simulation testing
- **Simple Bankrun**: `tests/token_distributor_bankrun_simple.ts` - Simplified test examples

## Program Functions

### Core Instructions

- **create_distributor**: Initialize a new token distribution campaign with automatic nonce management
- **set_time**: Configure distribution start and end times (14-day window, can be modified before distribution starts)
- **set_merkle_root**: Set merkle root for claim verification
- **claim**: Allow users to claim tokens with merkle proof verification
- **withdraw**: Reclaim remaining tokens after distribution ends
- **close_claim_status**: Close claim status accounts for rent recovery

### Key Features

- **Merkle Tree Verification**: Secure and efficient claim validation
- **Time-Bounded Distributions**: Configurable 14-day distribution windows
- **Role-Based Access Control**: Owner and operator role separation
- **Persistent Claim Tracking**: Maintains claim status across merkle root updates
- **Cross-Program Compatibility**: Supports both SPL Token and Token 2022
- **Event System**: Comprehensive event emission for tracking and analytics

## Architecture

- **Distributor PDA**: Stores distribution parameters and state
- **Token Vault PDA**: Holds tokens to be distributed, controlled by distributor
- **Claim Status PDAs**: Track individual user claim progress
- **Owner Nonce PDA**: Manages automatic nonce assignment for multiple distributions
- **Merkle Tree**: Off-chain structure for efficient claim verification

## Security Features

- PDA-based access control with owner/operator role separation
- Merkle proof verification for claim eligibility
- Time-based distribution windows to prevent manipulation
- Overflow protection with checked arithmetic
- CEI (Checks-Effects-Interactions) pattern implementation
- Support for both SPL Token and Token 2022 programs

## Development

### Code Quality

```bash
# Run linting
yarn lint

# Fix linting issues
yarn lint:fix
```

### Testing Frameworks

This project supports multiple testing approaches:

1. **Standard Anchor Tests**: Traditional testing with full blockchain simulation
2. **Bankrun**: High-performance testing with parallel execution
3. **LiteSVM**: Fast simulation for rapid development cycles

## Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add or update tests as needed
5. Ensure all tests pass
6. Submit a Pull Request with a clear description of your changes

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
