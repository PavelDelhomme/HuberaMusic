package cloud.hubera.id.sso

data class HuberaIdAccount(
    val email: String,
    val accessToken: String = "",
    val refreshToken: String = "",
    val displayName: String = "",
    val issuer: String = "hubera-id",
    val gatewayUrl: String = "",
    val tenantId: Int = 1,
    val sourcePackage: String = "",
    val updatedAt: Long = 0L,
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "email" to email,
        "access_token" to accessToken,
        "refresh_token" to refreshToken,
        "display_name" to displayName,
        "issuer" to issuer,
        "gateway_url" to gatewayUrl,
        "tenant_id" to tenantId,
        "source_package" to sourcePackage,
        "updated_at" to updatedAt,
    )

    val isMusicIssuer: Boolean
        get() = issuer.equals("music", ignoreCase = true) ||
            issuer.contains("ytmusic", ignoreCase = true)
}
