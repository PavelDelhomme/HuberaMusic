package ovh.delhomme.ytmusic.player

/**
 * Politique Next/Prev pure (testable sans Exo).
 *
 * Contrat produit :
 * - Précédent = **titre d’avant** (pas restart à 3 s Media3).
 * - Un seul titre → null (l’appelant restart à 0).
 * - En début de fenêtre Exo avec file Holder plus large → utiliser Holder.index.
 */
fun resolvePreviousQueueIndex(
    curExo: Int,
    exoCount: Int,
    holderIndex: Int,
    holderQueueSize: Int,
): Int? {
    val cur = curExo.coerceAtLeast(0)
    return when {
        cur > 0 -> cur - 1
        exoCount > 1 -> exoCount - 1
        holderQueueSize > 1 && holderIndex > 0 -> holderIndex - 1
        holderQueueSize > 1 -> holderQueueSize - 1
        else -> null
    }
}

/**
 * Cible de skip Prev après pickReadySkipTarget.
 * Ne jamais rester sur [cur] si [askedPrev] existe et diffère.
 */
fun resolvePrevSkipTarget(cur: Int, askedPrev: Int, pickReady: Int): Int {
    return when {
        pickReady != cur -> pickReady
        askedPrev != cur -> askedPrev
        else -> cur
    }
}
