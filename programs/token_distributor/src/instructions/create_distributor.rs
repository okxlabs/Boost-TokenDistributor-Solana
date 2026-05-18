use crate::constants::*;
use crate::error::*;
use crate::event::*;
use crate::state::*;
use crate::utils::transfer_token;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token_2022::spl_token_2022::extension::{
    permanent_delegate::PermanentDelegate,
    transfer_fee::TransferFeeConfig,
    BaseStateWithExtensions,
    StateWithExtensions,
};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

/**
 * Account context for creating a new token distributor
 *
 * This instruction initializes a new token distributor with automatic nonce management:
 * - Creates or updates a nonce state PDA to track nonce numbers
 * - Creates a distributor PDA with auto-incremented nonce number
 * - Creates a token vault PDA to hold the tokens to be distributed
 * - Transfers the initial token amount from owner to the vault
 * - Sets up the operator who can manage the distribution
 *
 * Access Control: Only the owner can create a distributor
 */
#[event_cpi]
#[derive(Accounts)]
pub struct CreateDistributor<'info> {
    /// Nonce state account (PDA) that tracks nonce numbers for this owner
    /// - Stores the current nonce counter for automatic nonce assignment
    /// - Derived from: ["owner_nonce", owner]
    #[account(
        init_if_needed,
        payer = owner,
        space = NonceState::LEN,
        seeds = [OWNER_NONCE_SEED.as_bytes(), owner.key().as_ref()],
        bump
    )]
    pub owner_nonce: Account<'info, NonceState>,

    /// The main distributor account (PDA)
    /// - Stores all distribution parameters and state
    /// - Derived from: ["distributor", token_mint, owner, current_nonce]
    /// - Nonce is automatically determined from owner_nonce.nonce + 1
    #[account(
        init,
        payer = owner,
        space = TokenDistributor::LEN,
        seeds = [
            DISTRIBUTOR_SEED.as_bytes(),
            token_mint.key().as_ref(),
            owner.key().as_ref(),
            (owner_nonce.nonce + 1).to_le_bytes().as_ref()
        ],
        bump
    )]
    pub distributor: Account<'info, TokenDistributor>,

    /// Token vault account (PDA) that holds the tokens to be distributed
    /// - Controlled by the distributor PDA as token authority
    /// - Derived from: ["vault", distributor_key]
    #[account(
        init,
        token::mint = token_mint,
        token::authority = distributor,
        token::token_program = token_program,
        seeds = [VAULT_SEED.as_bytes(), distributor.key().as_ref()],
        bump,
        payer = owner,
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    /// The token mint for the tokens being distributed
    /// - Supports both SPL Token and Token 2022 programs
    #[account(
        token::token_program = token_program,
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// Owner's token account containing the tokens to be deposited
    /// - Must be owned by the owner signer
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,

    /// The owner of the distributor
    /// - Has full control over the distributor
    /// - Can withdraw remaining tokens after distribution ends
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The operator account that can manage the distribution
    /// - Can set start time and update merkle root
    /// CHECK: This account is validated by storing its key in the distributor state
    pub operator: AccountInfo<'info>,

    /// System program for account creation
    pub system_program: Program<'info, System>,

    /// Token program (supports both SPL Token and Token 2022)
    pub token_program: Interface<'info, TokenInterface>,

    /// Rent sysvar for rent exemption calculations
    pub rent: Sysvar<'info, Rent>,
}

/// Rejects mints whose properties would allow an external party to bypass or
/// permanently lock the vault:
///   - freeze_authority: holder can freeze the vault PDA, blocking all claims
///   - TransferFeeConfig: fee deducted on every transfer causes vault underfunding
///   - PermanentDelegate: delegate can drain the vault directly via transfer_checked
fn assert_mint_is_safe(mint_info: &AccountInfo, token_program: &Pubkey) -> Result<()> {
    if token_program == &anchor_spl::token_2022::ID {
        let data = mint_info.try_borrow_data()?;
        let state = StateWithExtensions::<anchor_spl::token_2022::spl_token_2022::state::Mint>::unpack(&data)
            .map_err(|_| error!(TokenDistributorError::UnsupportedMintExtension))?;
        require!(
            state.base.freeze_authority == COption::None,
            TokenDistributorError::UnsupportedMintExtension
        );
        require!(
            state.get_extension::<TransferFeeConfig>().is_err(),
            TokenDistributorError::UnsupportedMintExtension
        );
        require!(
            state.get_extension::<PermanentDelegate>().is_err(),
            TokenDistributorError::UnsupportedMintExtension
        );
    } else {
        let data = mint_info.try_borrow_data()?;
        let state = anchor_spl::token_2022::spl_token_2022::state::Mint::unpack(&data)
            .map_err(|_| error!(TokenDistributorError::UnsupportedMintExtension))?;
        require!(
            state.freeze_authority == COption::None,
            TokenDistributorError::UnsupportedMintExtension
        );
    }
    Ok(())
}

/**
 * Creates a new token distributor with automatic nonce management
 *
 * @param ctx - The account context containing all required accounts
 * @param initial_total_amount - Total amount of tokens to be distributed
 */
pub fn handle_create_distributor(
    ctx: Context<CreateDistributor>,
    initial_total_amount: u64,
) -> Result<()> {
    // Validate initial total amount
    require!(
        initial_total_amount > 0,
        TokenDistributorError::InvalidAmount
    );

    // Validate operator is not empty account
    require!(
        ctx.accounts.operator.key() != Pubkey::default(),
        TokenDistributorError::InvalidOperator
    );

    // Reject mints with unsafe extensions or authorities
    assert_mint_is_safe(
        &ctx.accounts.token_mint.to_account_info(),
        &ctx.accounts.token_program.key(),
    )?;

    let owner_nonce = &mut ctx.accounts.owner_nonce;
    let distributor = &mut ctx.accounts.distributor;

    // Calculate nonce number with overflow protection
    let current_nonce = owner_nonce
        .nonce
        .checked_add(1)
        .ok_or(TokenDistributorError::ArithmeticOverflow)?;

    // Update nonce state with current nonce
    owner_nonce.nonce = current_nonce;

    // Initialize distributor state with auto-assigned nonce
    distributor.bump = ctx.bumps.distributor;
    distributor.nonce = current_nonce;
    distributor.owner = ctx.accounts.owner.key();
    distributor.operator = ctx.accounts.operator.key();
    distributor.token_mint = ctx.accounts.token_mint.key();
    distributor.token_vault = ctx.accounts.token_vault.key();
    distributor.initial_total_amount = initial_total_amount;
    // Note: total_claimed, start_time, end_time, merkle_root use default values (0)

    // Transfer tokens from owner to vault
    // This ensures the vault has the tokens available for distribution
    // Uses transfer_checked for compatibility with both SPL Token and Token 2022
    transfer_token(
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.owner_token_account.to_account_info(),
        ctx.accounts.token_vault.to_account_info(),
        ctx.accounts.token_mint.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        initial_total_amount,
        ctx.accounts.token_mint.decimals,
        None, // No signer seeds needed for owner-signed transfer
    )?;

    // Emit event for off-chain indexing and monitoring
    // Uses emit_cpi! for cross-program call compatibility
    emit_cpi!(DistributorCreated {
        distributor: distributor.key(),
        nonce: current_nonce,
        owner: ctx.accounts.owner.key(),
        operator: ctx.accounts.operator.key(),
        token_mint: ctx.accounts.token_mint.key(),
        token_vault: ctx.accounts.token_vault.key(),
        initial_total_amount,
    });

    Ok(())
}
