import { near, UnorderedSet } from "near-sdk-js";
import { Contract, NFT_METADATA_SPEC, NFT_STANDARD_NAME } from ".";
import { Token } from "./metadata";

// TODO: don't hard code storage byte cost
export const storageCostPerByte = BigInt('10000000000000000000');

export function assert(statement: boolean, message: string) {
    if (!statement) {
        throw Error(`Assertion failed: ${message}`)
    }
}

//convert the royalty percentage and amount to pay into a payout (U128)
export function royalty_to_payout(royaltyPercentage: number, amountToPay: bigint): bigint {
    return BigInt(royaltyPercentage) * BigInt(amountToPay) / BigInt(10000)
}

//calculate how many bytes the account ID is taking up
export function bytes_for_approved_account_id(accountId: string): number {
    // The extra 4 bytes are coming from Borsh serialization to store the length of the string.
    return accountId.length + 4 + 8;
}

//refund the storage taken up by passed in approved account IDs and send the funds to the passed in account ID. 
export function refund_approved_account_ids_iter(accountId: string, approvedAccountIds: string[]) {
    //get the storage total by going through and summing all the bytes for each approved account IDs
    let storageReleased = approvedAccountIds.map(e => bytes_for_approved_account_id(e)).reduce((partialSum, a) => partialSum + a, 0);
    let amountToTransfer = BigInt(storageReleased) * storageCostPerByte;
    
    // Send the money to the beneficiary (TODO: don't use batch actions)
    const promise = near.promiseBatchCreate(accountId);
    near.promiseBatchActionTransfer(promise, amountToTransfer)
}

//refund a map of approved account IDs and send the funds to the passed in account ID
export function refund_approved_account_ids(accountId: string, approvedAccountIds: { [key: string]: number }) {
    //call the refund_approved_account_ids_iter with the approved account IDs as keys
    refund_approved_account_ids_iter(accountId, Object.keys(approvedAccountIds));
}

//refund the initial deposit based on the amount of storage that was used up
export function refundDeposit(storageUsed: number) {
    //get how much it would cost to store the information
    let requiredCost = BigInt(storageUsed) * storageCostPerByte
    //get the attached deposit
    let attachedDeposit = near.attachedDeposit().valueOf();

    //make sure that the attached deposit is greater than or equal to the required cost
    assert(
        requiredCost <= attachedDeposit,
        `Must attach ${requiredCost} yoctoNEAR to cover storage`
    )

    //get the refund amount from the attached deposit - required cost
    let refund = attachedDeposit - requiredCost;

    //if the refund is greater than 1 yocto NEAR, we refund the predecessor that amount
    if (refund > 1) {
        // Send the money to the beneficiary (TODO: don't use batch actions)
        const promise = near.promiseBatchCreate(near.predecessorAccountId());
        near.promiseBatchActionTransfer(promise, refund)
    }
}

//used to make sure the user attached exactly 1 yoctoNEAR
export function assert_one_yocto() {
    assert(near.attachedDeposit().toString() === "1", "Requires attached deposit of exactly 1 yoctoNEAR");
}

//Assert that the user has attached at least 1 yoctoNEAR (for security reasons and to pay for storage)
export function assert_at_least_one_yocto() {
    assert(near.attachedDeposit().valueOf() >= BigInt(1), "Requires attached deposit of at least 1 yoctoNEAR");
}

//add a token to the set of tokens an owner has
export function internal_add_token_to_owner(contract: Contract, accountId: string, tokenId: string) {
    //get the set of tokens for the given account
    let tokenSet = contract.tokensPerOwner.get(accountId);

    if(tokenSet == null) {
        //if the account doesn't have any tokens, we create a new unordered set
        tokenSet = new UnorderedSet(accountId);
    }

    //we insert the token ID into the set
    tokenSet.set(tokenId);

    //we insert that set for the given account ID. 
    contract.tokensPerOwner.set(accountId, tokenSet);
}

//remove a token from an owner (internal method and can't be called directly via CLI).
export function internal_remove_token_from_owner(contract: Contract, accountId: string, tokenId: string) {
    //we get the set of tokens that the owner has
    let tokenSet = contract.tokensPerOwner.get(accountId);
    //if there is no set of tokens for the owner, we panic with the following message:
    if (tokenSet == null) {
        near.panic("Token should be owned by the sender");
    }

    //we remove the the token_id from the set of tokens
    tokenSet.remove(tokenId)

    //if the token set is now empty, we remove the owner from the tokens_per_owner collection
    if (tokenSet.isEmpty()) {
        contract.tokensPerOwner.remove(accountId);
    } else { //if the token set is not empty, we simply insert it back for the account ID. 
        contract.tokensPerOwner.set(accountId, tokenSet);
    }
}

//transfers the NFT to the receiver_id (internal method and can't be called directly via CLI).
export function internal_transfer(contract: Contract, senderId: string, receiverId: string, tokenId: string, approvalId: number, memo: string): Token {
    //get the token object by passing in the token_id
    let token = contract.tokensById.get(tokenId);
    if (token == null) {
        near.panic("no token found");
    }

    //if the sender doesn't equal the owner, we check if the sender is in the approval list
    if (senderId != token.owner_id) {
        //if the token's approved account IDs doesn't contain the sender, we panic
        near.log(`token: ${JSON.stringify(token)}`)
        if (!token.approved_account_ids.hasOwnProperty(senderId)) {
            near.panic("Unauthorized");
        }

        // If they included an approval_id, check if the sender's actual approval_id is the same as the one included
        if (approvalId != null) {
            //get the actual approval ID
            let actualApprovalId = token.approved_account_ids[senderId];
            //if the sender isn't in the map, we panic
            if (actualApprovalId == null) {
                near.panic("Sender is not approved account");
            }

            //make sure that the actual approval ID is the same as the one provided
            assert(actualApprovalId == approvalId, `The actual approval_id ${actualApprovalId} is different from the given approval_id ${approvalId}`);
        }
    }

    //we make sure that the sender isn't sending the token to themselves
    assert(token.owner_id != receiverId, "The token owner and the receiver should be different")

    //we remove the token from it's current owner's set
    internal_remove_token_from_owner(contract, token.owner_id, tokenId);
    //we then add the token to the receiver_id's set
    internal_add_token_to_owner(contract, receiverId, tokenId);

    //we create a new token struct 
    let newToken = new Token ({
        ownerId: receiverId,
        //reset the approval account IDs
        approvedAccountIds: {},
        nextApprovalId: token.next_approval_id,
        //we copy over the royalties from the previous token
        royalty: token.royalty,
    });

    //insert that new token into the tokens_by_id, replacing the old entry 
    contract.tokensById.set(tokenId, newToken);

    //if there was some memo attached, we log it. 
    if (memo != null) {
        near.log(`Memo: ${memo}`);
    }

    // Default the authorized ID to be None for the logs.
    let authorizedId;

    //if the approval ID was provided, set the authorized ID equal to the sender
    if (approvalId != null) {
        authorizedId = senderId
    }

    // Construct the transfer log as per the events standard.
    let nftTransferLog = {
        // Standard name ("nep171").
        standard: NFT_STANDARD_NAME,
        // Version of the standard ("nft-1.0.0").
        version: NFT_METADATA_SPEC,
        // The data related with the event stored in a vector.
        event: "nft_transfer",
        data: [
            {
                // The optional authorized account ID to transfer the token on behalf of the old owner.
                authorized_id: authorizedId,
                // The old owner's account ID.
                old_owner_id: token.owner_id,
                // The account ID of the new owner of the token.
                new_owner_id: receiverId,
                // A vector containing the token IDs as strings.
                token_ids: [tokenId],
                // An optional memo to include.
                memo,
            }
        ]
    }

    // Log the serialized json.
    near.log(JSON.stringify(nftTransferLog));

    //return the previous token object that was transferred.
    return token
}