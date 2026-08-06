import { Body, Container, Head, Html, Preview, Text } from '@react-email/components'

export const subject = 'Hi {{name}}'

export function WelcomeEmail(properties: { readonly name: string }) {
  return (
    <Html>
      <Head />
      <Preview>Welcome to Ruguin</Preview>
      <Body style={{ fontFamily: 'sans-serif', backgroundColor: '#ffffff' }}>
        <Container>
          <Text>Hi {properties.name}</Text>
        </Container>
      </Body>
    </Html>
  )
}
