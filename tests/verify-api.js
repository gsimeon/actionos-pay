async function main() {
  const payload = {
    prompt: 'Order 2 Dell XPS 15 laptops from AfriTech. Budget under 5000.',
    budgetLimitCents: 500000,
  };

  const res = await fetch('http://localhost:3000/api/procurement/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  console.log('Status:', res.status);
  console.log('Response:', JSON.stringify(data, null, 2));
}

main().catch(console.error);
