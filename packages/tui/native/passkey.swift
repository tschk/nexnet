import AppKit
import AuthenticationServices
import Foundation

struct Request: Decodable {
    let operation: String
    let rpId: String
    let challenge: String
    let userId: String?
    let userName: String?
    let displayName: String?
    let credentialId: String?
}

struct RegistrationResponse: Encodable {
    let credentialId: String
    let attestationObject: String
    let clientDataJSON: String
}

struct AssertionResponse: Encodable {
    let credentialId: String
    let authenticatorData: String
    let signature: String
    let clientDataJSON: String
    let userId: String?
}

enum BridgeError: Error, LocalizedError {
    case invalidRequest
    case authorizationFailed(String)
    case unexpectedCredential

    var errorDescription: String? {
        switch self {
        case .invalidRequest: return "Invalid passkey request"
        case .authorizationFailed(let message): return message
        case .unexpectedCredential: return "Unexpected passkey credential"
        }
    }
}

func base64urlDecode(_ value: String) -> Data? {
    let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let remainder = padded.count % 4
    return Data(base64Encoded: remainder == 0 ? padded : padded + String(repeating: "=", count: 4 - remainder))
}

func base64urlEncode(_ value: Data) -> String {
    value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

@MainActor
final class AuthorizationDelegate: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    func authorize(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        continuation?.resume(returning: authorization)
        continuation = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: BridgeError.authorizationFailed(error.localizedDescription))
        continuation = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
    }
}

@main
struct NexnetPasskeyBridge {
    @MainActor
    static func main() async {
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            let input = try JSONDecoder().decode(Request.self, from: data)
            guard let challenge = base64urlDecode(input.challenge), !input.rpId.isEmpty else { throw BridgeError.invalidRequest }
            NSApplication.shared.setActivationPolicy(.accessory)
            NSApp.activate(ignoringOtherApps: true)
            let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: input.rpId)
            let delegate = AuthorizationDelegate()
            let authorization: ASAuthorization
            switch input.operation {
            case "register":
                guard let userId = input.userId.flatMap(base64urlDecode), let userName = input.userName, !userName.isEmpty else { throw BridgeError.invalidRequest }
                let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: userName, userID: userId)
                if let displayName = input.displayName, !displayName.isEmpty { request.displayName = displayName }
                authorization = try await delegate.authorize(request)
                guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration, let attestationObject = credential.rawAttestationObject else { throw BridgeError.unexpectedCredential }
                let output = RegistrationResponse(credentialId: base64urlEncode(credential.credentialID), attestationObject: base64urlEncode(attestationObject), clientDataJSON: base64urlEncode(credential.rawClientDataJSON))
                try write(output)
            case "assert":
                let request = provider.createCredentialAssertionRequest(challenge: challenge)
                if let credentialId = input.credentialId.flatMap(base64urlDecode) {
                    request.allowedCredentials = [ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: credentialId)]
                }
                authorization = try await delegate.authorize(request)
                guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else { throw BridgeError.unexpectedCredential }
                let output = AssertionResponse(credentialId: base64urlEncode(credential.credentialID), authenticatorData: base64urlEncode(credential.rawAuthenticatorData), signature: base64urlEncode(credential.signature), clientDataJSON: base64urlEncode(credential.rawClientDataJSON), userId: credential.userID.map(base64urlEncode))
                try write(output)
            default:
                throw BridgeError.invalidRequest
            }
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            Foundation.exit(1)
        }
    }

    static func write<T: Encodable>(_ value: T) throws {
        let data = try JSONEncoder().encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}
