
async function test() {
  try {
    console.log('Testing /qr without password...');
    const res1 = await fetch('http://localhost:3007/qr', {
      headers: { 'Accept': 'text/html' }
    });
    console.log('Status without password:', res1.status);
    const body1 = await res1.text();
    console.log('Body snippet:', body1.substring(0, 200));

    console.log('\nTesting /qr with password...');
    const res2 = await fetch('http://localhost:3007/qr?pw=admin123');
    console.log('Status with password:', res2.status);
    const body2 = await res2.text();
    console.log('Body snippet:', body2.substring(0, 200));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

test();
