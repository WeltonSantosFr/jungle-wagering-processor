import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // Ponto de extensão explícito para Identity Provider externo (Keycloak/Zitadel) via JWT/JWKS.
    // Atualmente configurado como no-op conforme instrução da Seção 2 do desafio.
    return true;
  }
}